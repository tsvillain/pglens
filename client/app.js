/**
 * pglens - PostgreSQL Database Viewer
 * 
 * Main client-side application for viewing PostgreSQL database tables.
 * Features:
 * - Multi-database connection support
 * - Multi-tab table viewing
 * - Client-side sorting and column management
 * - Cursor-based pagination for large tables
 * - Theme support (light/dark/system)
 * - Real-time table search
 */

// Application state
let connections = []; // Array of active connections: { id, name, connectionString, sslMode }
let activeConnectionId = null; // Currently active connection ID
let tabs = []; // Array of tab objects: { connectionId, tableName, page, totalCount, sortColumn, sortDirection, data, hiddenColumns, columnWidths, cursor, cursorHistory, hasPrimaryKey, isApproximate }
let activeTabIndex = -1; // Currently active tab index
let allTables = []; // All available tables from the current database connection
let searchQuery = ''; // Current search filter for tables
let currentTheme = 'system'; // Current theme: 'light', 'dark', or 'system'

// UI Elements
const sidebar = document.getElementById('sidebar');
const sidebarContent = document.getElementById('sidebarContent');
const connectionsList = document.getElementById('connectionsList');
const tableCount = document.getElementById('tableCount');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarSearch = document.getElementById('sidebarSearch');
const themeButton = document.getElementById('themeButton');
const themeMenu = document.getElementById('themeMenu');
const tabsContainer = document.getElementById('tabsContainer');
const tabsBar = document.getElementById('tabsBar');
const tableView = document.getElementById('tableView');
const pagination = document.getElementById('pagination');
const addConnectionButton = document.getElementById('addConnectionButton');

// Connection UI Elements
const connectionDialog = document.getElementById('connectionDialog');
const closeConnectionDialogButton = document.getElementById('closeConnectionDialog');
const connectionNameInput = document.getElementById('connectionName');
const connectionUrlInput = document.getElementById('connectionUrl');
const connectionTabs = document.querySelectorAll('.connection-type-tab');
const modeUrl = document.getElementById('modeUrl');
const modeParams = document.getElementById('modeParams');
const connHost = document.getElementById('connHost');
const connPort = document.getElementById('connPort');
const connDatabase = document.getElementById('connDatabase');
const connUser = document.getElementById('connUser');
const connPassword = document.getElementById('connPassword');
const sslModeSelect = document.getElementById('sslMode');
const connectButton = document.getElementById('connectButton');
const connectionError = document.getElementById('connectionError');
const loadingOverlay = document.getElementById('loadingOverlay');

/**
 * Initialize the application when DOM is ready.
 * Sets up event listeners and loads initial data.
 */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  fetchConnections(); // Check status and load connections

  // Connection Event Listeners
  connectButton.addEventListener('click', handleConnect);
  addConnectionButton.addEventListener('click', () => showConnectionDialog(true));
  closeConnectionDialogButton.addEventListener('click', hideConnectionDialog);

  connectionTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Switch active tab
      connectionTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Show content
      const target = tab.dataset.target;
      if (target === 'url') {
        modeUrl.style.display = 'block';
        modeParams.style.display = 'none';
        connectionDialog.dataset.inputMode = 'url';
      } else {
        modeUrl.style.display = 'none';
        modeParams.style.display = 'block';
        connectionDialog.dataset.inputMode = 'params';
      }
    });
  });

  // Allow Enter key to submit connection form
  connectionUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleConnect();
    }
  });

  sidebarToggle.addEventListener('click', () => {
    if (tabs.length > 0) {
      sidebar.classList.toggle('minimized');
    }
  });

  updateSidebarToggleState();

  sidebarSearch.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    filterAndRenderTables();
  });

  themeButton.addEventListener('click', (e) => {
    e.stopPropagation();
    themeMenu.style.display = themeMenu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', (e) => {
    if (!themeButton.contains(e.target) && !themeMenu.contains(e.target)) {
      themeMenu.style.display = 'none';
    }
  });

  const themeOptions = themeMenu.querySelectorAll('.theme-option');
  themeOptions.forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const theme = option.getAttribute('data-theme');
      setTheme(theme);
      themeMenu.style.display = 'none';
    });
  });

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (currentTheme === 'system') {
      applyTheme();
    }
  });
});

/**
 * Initialize theme from localStorage or use system preference.
 * Theme preference is persisted across sessions.
 */
function initTheme() {
  const savedTheme = localStorage.getItem('pglens-theme');
  if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
    currentTheme = savedTheme;
  }
  applyTheme();
  updateThemeIcon();
}

/**
 * Set the application theme and persist to localStorage.
 * @param {string} theme - Theme name: 'light', 'dark', or 'system'
 */
function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('pglens-theme', theme);
  applyTheme();
  updateThemeIcon();
}

/**
 * Apply the current theme to the document.
 * If theme is 'system', detects OS preference automatically.
 */
function applyTheme() {
  let themeToApply = currentTheme;

  if (currentTheme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    themeToApply = prefersDark ? 'dark' : 'light';
  }

  document.documentElement.setAttribute('data-theme', themeToApply);
}

function updateThemeIcon() {
  const themeIcon = themeButton.querySelector('.theme-icon');
  if (currentTheme === 'light') {
    themeIcon.textContent = '☀️';
  } else if (currentTheme === 'dark') {
    themeIcon.textContent = '🌙';
  } else {
    themeIcon.textContent = '🌓';
  }
}

function updateSidebarToggleState() {
  if (tabs.length === 0 && connections.length === 0) {
    sidebarToggle.disabled = true;
    sidebarToggle.classList.add('disabled');
    sidebar.classList.remove('minimized');
  } else {
    sidebarToggle.disabled = false;
    sidebarToggle.classList.remove('disabled');
  }
}

/**
 * Fetch active connections from API.
 */
async function fetchConnections() {
  try {
    const response = await fetch('/api/connections');
    const data = await response.json();

    connections = data.connections || [];

    if (connections.length > 0) {
      if (!activeConnectionId || !connections.find(c => c.id === activeConnectionId)) {
        activeConnectionId = connections[0].id;
      }
      renderConnectionsList();
      loadTables();
      hideConnectionDialog();
    } else {
      showConnectionDialog(false);
    }
  } catch (error) {
    console.error('Failed to fetch connections:', error);
    showConnectionDialog(false);
  }
}

/**
 * Render the list of active connections in the sidebar.
 */
function renderConnectionsList() {
  connectionsList.innerHTML = '';

  connections.forEach(conn => {
    const li = document.createElement('li');
    li.className = 'connection-item';
    if (conn.id === activeConnectionId) {
      li.classList.add('active');
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'connection-name';
    nameSpan.textContent = conn.name;
    nameSpan.title = 'Click to edit connection';
    nameSpan.style.cursor = 'pointer';
    nameSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      handleConnectionEdit(conn);
    });

    // Add click event for the li to switch connection if not clicking name or close
    li.addEventListener('click', (e) => {
      if (e.target !== nameSpan && e.target !== disconnectBtn) {
        switchConnection(conn.id);
      }
    });

    const disconnectBtn = document.createElement('button');
    disconnectBtn.className = 'connection-disconnect';
    disconnectBtn.innerHTML = '×';
    disconnectBtn.title = 'Disconnect';
    disconnectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDisconnect(conn.id);
    });

    li.appendChild(nameSpan);
    li.appendChild(disconnectBtn);
    connectionsList.appendChild(li);
  });
}

/**
 * Switch the active connection.
 * @param {string} connectionId - The connection ID to switch to
 */
function switchConnection(connectionId) {
  if (activeConnectionId === connectionId) return;

  activeConnectionId = connectionId;
  renderConnectionsList();
  loadTables();

  // Clear tables view if no tab from this connection is active
  const currentTab = getActiveTab();
  if (currentTab && currentTab.connectionId !== activeConnectionId) {
    // Try to find the last active tab for this connection
    const tabIndex = tabs.findIndex(t => t.connectionId === activeConnectionId);
    if (tabIndex !== -1) {
      switchToTab(tabIndex);
    } else {
      // No tabs for this connection, show empty state
      tableView.innerHTML = '<div class="empty-state"><p>Select a table from the sidebar to view its data</p></div>';
      pagination.style.display = 'none';

      // Deselect all tabs visually
      const tabElements = tabsBar.querySelectorAll('.tab');
      tabElements.forEach(el => el.classList.remove('active'));
      activeTabIndex = -1;
    }
  }
}

/**
 * Handle database connection.
 */
async function handleConnect() {
  let url = '';
  const connectionName = connectionNameInput.value.trim();
  const sslMode = sslModeSelect.value;
  const inputMode = connectionDialog.dataset.inputMode || 'url';

  if (inputMode === 'url') {
    url = connectionUrlInput.value.trim();
  } else {
    // Build URL from params
    const host = connHost.value.trim() || 'localhost';
    const port = connPort.value.trim() || '5432';
    const database = connDatabase.value.trim() || 'postgres';
    const user = connUser.value.trim();
    const password = connPassword.value;

    if (!user) {
      showConnectionError('Username is required');
      return;
    }

    url = buildConnectionString(user, password, host, port, database);
  }

  if (!url) {
    showConnectionError('Please enter a connection URL');
    return;
  }

  // Validate URL format
  try {
    if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
      showConnectionError('URL must start with postgres:// or postgresql://');
      return;
    }

    const urlObj = new URL(url);
    if (!urlObj.pathname || urlObj.pathname === '/') {
      showConnectionError('URL must include a database name');
      return;
    }
  } catch (e) {
    showConnectionError('Invalid URL format');
    return;
  }

  try {
    setConnectingState(true);


    let urlPath = '/api/connect';
    let method = 'POST';

    if (connectionDialog.dataset.mode === 'edit') {
      const id = connectionDialog.dataset.connectionId;
      urlPath = `/api/connections/${id}`;
      method = 'PUT';
    }

    const response = await fetch(urlPath, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sslMode, name: connectionName || undefined })
    });

    const data = await response.json();

    if (response.ok) {
      if (data.connected || data.updated) {
        // If updated, update local array
        if (data.updated) {
          const index = connections.findIndex(c => c.id === data.connectionId);
          if (index !== -1) {
            connections[index] = {
              ...connections[index],
              name: data.name,
              connectionString: url,
              sslMode: sslMode
            };
          }
        } else {
          // New connection
          // Check if this connection ID already exists in our list (backend might return existing one)
          const existingIndex = connections.findIndex(c => c.id === data.connectionId);
          if (existingIndex === -1) {
            connections.push({
              id: data.connectionId,
              name: data.name,
              connectionString: url,
              sslMode: sslMode
            });
          } else {
            console.log('Connection already exists, switching to it');
          }
        }

        activeConnectionId = data.connectionId;

        renderConnectionsList();
        loadTables();
        hideConnectionDialog();
        // Don't clear inputs here, will clear on show
      }
    } else {
      showConnectionError(data.error || 'Failed to connect');
    }
  } catch (error) {
    showConnectionError(error.message);
  } finally {
    setConnectingState(false);
  }
}

/**
 * Handle database disconnection.
 * @param {string} connectionId - ID of connection to disconnect
 */
async function handleDisconnect(connectionId) {
  if (!confirm('Are you sure you want to disconnect? Associated tabs will be closed.')) {
    return;
  }

  try {
    const response = await fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId })
    });

    if (response.ok) {
      // Remove from local state
      connections = connections.filter(c => c.id !== connectionId);

      // Close associated tabs
      const tabsToRemove = [];
      tabs.forEach((tab, index) => {
        if (tab.connectionId === connectionId) {
          tabsToRemove.push(index);
        }
      });

      // Remove tabs in reverse order to maintain indices
      for (let i = tabsToRemove.length - 1; i >= 0; i--) {
        closeTab(tabsToRemove[i]);
      }

      if (connections.length === 0) {
        activeConnectionId = null;
        sidebarContent.innerHTML = '';
        tableCount.textContent = '0';
        renderConnectionsList();
        showConnectionDialog(false);
      } else {
        if (activeConnectionId === connectionId) {
          // Switch to another connection (the first one)
          activeConnectionId = connections[0].id;
          loadTables();
        }
        renderConnectionsList();
      }
    }
  } catch (error) {
    console.error('Failed to disconnect:', error);
  }
}



function showConnectionDialog(allowClose, editMode = false, connection = null) {
  connectionDialog.style.display = 'flex';
  connectionError.style.display = 'none';

  const title = connectionDialog.querySelector('h2');
  title.textContent = editMode ? 'Edit Connection' : 'Connect to Database';
  connectButton.textContent = editMode ? 'Save' : 'Connect';

  connectionDialog.dataset.mode = editMode ? 'edit' : 'add';

  if (editMode && connection) {
    connectionDialog.dataset.connectionId = connection.id;
    connectionNameInput.value = connection.name || '';
    sslModeSelect.value = connection.sslMode || 'prefer';

    // Try to parse URL to populate params
    const parsed = parseConnectionString(connection.connectionString);
    if (parsed) {
      connHost.value = parsed.host;
      connPort.value = parsed.port;
      connDatabase.value = parsed.database;
      connUser.value = parsed.user;
      connPassword.value = parsed.password;
    }
    connectionUrlInput.value = connection.connectionString || '';
  } else {
    delete connectionDialog.dataset.connectionId;
    connectionUrlInput.value = '';
    connectionNameInput.value = '';
    sslModeSelect.value = 'prefer';

    // Reset params
    connHost.value = 'localhost';
    connPort.value = '5432';
    connDatabase.value = 'postgres';
    connUser.value = '';
    connPassword.value = '';
  }

  // Reset tabs to Params mode by default (since we swapped buttons, tab[0] is Params)
  connectionTabs.forEach(t => t.classList.remove('active'));
  connectionTabs[0].classList.add('active');

  modeUrl.style.display = 'none';
  modeParams.style.display = 'block';
  connectionDialog.dataset.inputMode = 'params';

  connHost.focus();

  if (allowClose && connections.length > 0) {
    closeConnectionDialogButton.style.display = 'block';
  } else {
    closeConnectionDialogButton.style.display = 'none';
  }
}

function buildConnectionString(user, password, host, port, database) {
  let auth = user;
  if (password) {
    auth += `:${encodeURIComponent(password)}`;
  }
  return `postgresql://${auth}@${host}:${port}/${database}`;
}

function parseConnectionString(urlStr) {
  try {
    if (!urlStr) return null;
    // Handle cases where protocol might be missing (though validation enforces it)
    if (!urlStr.includes('://')) {
      urlStr = 'postgresql://' + urlStr;
    }
    const url = new URL(urlStr);
    return {
      host: url.hostname || 'localhost',
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || 'postgres',
      user: url.username || '',
      password: url.password || '' // Note: URL decoding happens automatically for username/password properties? Verify. 
      // Actually URL properties are usually decoded. decodeURIComponent check might be needed if raw.
    };
  } catch (e) {
    return null;
  }
}

function handleConnectionEdit(connection) {
  showConnectionDialog(true, true, connection);
}

function hideConnectionDialog() {
  connectionDialog.style.display = 'none';
}

function showConnectionError(message) {
  connectionError.textContent = message;
  connectionError.style.display = 'block';
}

function setConnectingState(isConnecting) {
  connectButton.disabled = isConnecting;
  connectButton.textContent = isConnecting ? 'Connecting...' : 'Connect';
  connectionNameInput.disabled = isConnecting;
  connectionUrlInput.disabled = isConnecting;
  sslModeSelect.disabled = isConnecting;
}

/**
 * Load all tables from the active database via API.
 * Fetches table list and updates the sidebar.
 */
async function loadTables() {
  if (!activeConnectionId) return;

  try {
    sidebarContent.innerHTML = '<div class="loading">Loading tables...</div>';

    const response = await fetch('/api/tables', {
      headers: { 'x-connection-id': activeConnectionId }
    });
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    allTables = data.tables;
    tableCount.textContent = allTables.length;

    filterAndRenderTables();
  } catch (error) {
    sidebarContent.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  }
}

function filterAndRenderTables() {
  if (allTables.length === 0) {
    sidebarContent.innerHTML = '<div class="empty">No tables found</div>';
    return;
  }

  const filteredTables = searchQuery
    ? allTables.filter(table => table.toLowerCase().includes(searchQuery))
    : allTables;

  if (searchQuery && filteredTables.length !== allTables.length) {
    tableCount.textContent = `${filteredTables.length} / ${allTables.length}`;
  } else {
    tableCount.textContent = allTables.length;
  }

  if (filteredTables.length === 0) {
    sidebarContent.innerHTML = '<div class="empty">No tables match your search</div>';
    return;
  }

  const tableList = document.createElement('ul');
  tableList.className = 'table-list';

  filteredTables.forEach(table => {
    const li = document.createElement('li');
    li.textContent = table;
    li.addEventListener('click', () => handleTableSelect(table));

    if (searchQuery) {
      const lowerTable = table.toLowerCase();
      const index = lowerTable.indexOf(searchQuery);
      if (index !== -1) {
        const before = table.substring(0, index);
        const match = table.substring(index, index + searchQuery.length);
        const after = table.substring(index + searchQuery.length);

        li.innerHTML = `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
      }
    }

    tableList.appendChild(li);
  });

  sidebarContent.innerHTML = '';
  sidebarContent.appendChild(tableList);

  updateSidebarActiveState();
}

/**
 * Escape HTML to prevent XSS attacks.
 * Converts special characters to HTML entities.
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateSidebarActiveState() {
  const activeTab = getActiveTab();

  // Only highlight sidebar if active tab belongs to active connection
  const activeTable = (activeTab && activeTab.connectionId === activeConnectionId) ? activeTab.tableName : null;

  if (!activeTable) {
    const tableItems = sidebarContent.querySelectorAll('.table-list li');
    tableItems.forEach(item => item.classList.remove('active'));
    return;
  }

  const tableItems = sidebarContent.querySelectorAll('.table-list li');
  tableItems.forEach(item => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = item.innerHTML;
    const tableName = tempDiv.textContent || tempDiv.innerText;

    if (tableName === activeTable) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

/**
 * Handle table selection - opens in a new tab or switches to existing tab.
 * Each tab maintains its own state (page, sort, hidden columns, etc.).
 * @param {string} tableName - Name of the table to open
 */
function handleTableSelect(tableName) {
  if (!activeConnectionId) return;

  // Check if tab already exists for this table AND connection
  const existingTabIndex = tabs.findIndex(tab =>
    tab.tableName === tableName && tab.connectionId === activeConnectionId
  );

  if (existingTabIndex !== -1) {
    switchToTab(existingTabIndex);
  } else {
    const newTab = {
      connectionId: activeConnectionId,
      tableName: tableName,
      page: 1,
      totalCount: 0,
      sortColumn: null,
      sortDirection: 'asc',
      data: null, // Cached table data
      hiddenColumns: [], // Columns hidden by user
      columnWidths: {}, // User-resized column widths
      cursor: null, // Cursor for cursor-based pagination
      cursorHistory: [], // History for backward navigation
      hasPrimaryKey: false, // Whether table has primary key
      isApproximate: false, // Whether count is approximate (for large tables)
      limit: 100 // Rows per page
    };
    tabs.push(newTab);
    activeTabIndex = tabs.length - 1;
    renderTabs();
    loadTableData();
  }

  updateSidebarActiveState();
  updateSidebarToggleState();
}

function switchToTab(index) {
  if (index < 0 || index >= tabs.length) return;

  activeTabIndex = index;
  const tab = tabs[activeTabIndex];

  // Switch connection if tab belongs to different connection
  if (tab.connectionId !== activeConnectionId) {
    activeConnectionId = tab.connectionId;
    renderConnectionsList();
    loadTables();
  }

  renderTabs();
  updateSidebarActiveState();

  if (tab.data) {
    renderTable(tab.data);
    renderPagination();
  } else {
    loadTableData();
  }
}

function closeTab(index, event) {
  if (event) {
    event.stopPropagation();
  }

  if (index < 0 || index >= tabs.length) return;

  const tabWasActive = (index === activeTabIndex);
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    activeTabIndex = -1;
    tabsContainer.style.display = 'none';
    tableView.innerHTML = '<div class="empty-state"><p>Select a table from the sidebar to view its data</p></div>';
    pagination.style.display = 'none';
    updateSidebarActiveState();
    updateSidebarToggleState();
    return;
  }

  // Adjust activeTabIndex
  if (activeTabIndex >= index) {
    activeTabIndex--;
  }
  if (activeTabIndex < 0) {
    activeTabIndex = 0;
  }

  // If we closed the active tab, switch to the new active one
  if (tabWasActive) {
    // Ensure index is within bounds
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;

    const newActiveTab = tabs[activeTabIndex];
    // Switch connection if needed
    if (newActiveTab && newActiveTab.connectionId !== activeConnectionId) {
      activeConnectionId = newActiveTab.connectionId;
      renderConnectionsList();
      loadTables();
    }
  }

  renderTabs();

  if (tabs.length > 0) {
    const tab = tabs[activeTabIndex];
    if (tab.data) {
      renderTable(tab.data);
      renderPagination();
    } else {
      loadTableData();
    }
    updateSidebarActiveState();
  }
}

function renderTabs() {
  if (tabs.length === 0) {
    tabsContainer.style.display = 'none';
    return;
  }

  tabsContainer.style.display = 'block';
  tabsBar.innerHTML = '';

  const closeAllButton = document.createElement('button');
  closeAllButton.className = 'close-all-button';
  closeAllButton.innerHTML = 'Close All';
  closeAllButton.title = 'Close all tabs';
  closeAllButton.addEventListener('click', closeAllTabs);
  tabsBar.appendChild(closeAllButton);

  tabs.forEach((tab, index) => {
    const tabElement = document.createElement('div');
    tabElement.className = `tab ${index === activeTabIndex ? 'active' : ''}`;
    // Add connection indicator for tab if multiple connections exist
    if (connections.length > 1) {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (conn) {
        tabElement.title = `${tab.tableName} (${conn.name})`;
      }
    }

    tabElement.addEventListener('click', () => switchToTab(index));

    const tabLabel = document.createElement('span');
    tabLabel.className = 'tab-label';
    tabLabel.textContent = tab.tableName;
    tabElement.appendChild(tabLabel);

    const closeButton = document.createElement('button');
    closeButton.className = 'tab-close';
    closeButton.innerHTML = '×';
    closeButton.addEventListener('click', (e) => closeTab(index, e));
    tabElement.appendChild(closeButton);

    tabsBar.appendChild(tabElement);
  });
}

function closeAllTabs() {
  tabs = [];
  activeTabIndex = -1;
  tabsContainer.style.display = 'none';
  tableView.innerHTML = '<div class="empty-state"><p>Select a table from the sidebar to view its data</p></div>';
  pagination.style.display = 'none';

  updateSidebarActiveState();
  updateSidebarToggleState();
}

function getActiveTab() {
  if (activeTabIndex < 0 || activeTabIndex >= tabs.length) return null;
  return tabs[activeTabIndex];
}

function handleRefresh() {
  const tab = getActiveTab();
  if (!tab) return;

  tab.data = null;

  const refreshButton = document.querySelector('#refreshButton');
  const refreshIcon = refreshButton ? refreshButton.querySelector('.refresh-icon') : null;
  if (refreshIcon) {
    refreshIcon.classList.add('spinning');
    setTimeout(() => {
      refreshIcon.classList.remove('spinning');
    }, 1000);
  }

  loadTableData();
}

/**
 * Check if a value is a JSON object or array (JSONB/JSON type).
 * Excludes null, Date objects, and other non-JSON types.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a JSON object or array
 */
function isJsonValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) {
      return false;
    }
    return Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]';
  }

  return false;
}

/**
 * Load table data for the active tab.
 * Uses cursor-based pagination for tables with primary keys (more efficient for large datasets).
 * Falls back to offset-based pagination for tables without primary keys or backward navigation.
 */
async function loadTableData() {
  const tab = getActiveTab();
  if (!tab) return;

  try {
    showLoading();
    // tableView.innerHTML = '<div class="loading-state"><p>Loading data from ' + tab.tableName + '...</p></div>';

    // Build query with cursor-based pagination if available
    if (!tab.limit) {
      tab.limit = 100; // Default limit for existing tabs
    }
    let queryString = `page=${tab.page}&limit=${tab.limit}`;
    if (tab.sortColumn) {
      queryString += `&sortColumn=${encodeURIComponent(tab.sortColumn)}&sortDirection=${tab.sortDirection}`;
    }

    if (tab.hasPrimaryKey && tab.cursor && tab.page > 1 && !tab.sortColumn) {
      // Use cursor for forward navigation (only if using default sort)
      queryString += `&cursor=${encodeURIComponent(tab.cursor)}`;
    }

    const response = await fetch(`/api/tables/${tab.tableName}?${queryString}`, {
      headers: { 'x-connection-id': tab.connectionId }
    });
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    tab.totalCount = data.totalCount;
    tab.hasPrimaryKey = data.hasPrimaryKey || false;
    tab.isApproximate = data.isApproximate || false;
    tab.data = data; // Cache data for client-side sorting

    // Update cursor for next page navigation
    if (data.nextCursor) {
      if (tab.cursor && tab.page > 1) {
        // Save current cursor to history for backward navigation
        if (tab.cursorHistory.length < tab.page - 1) {
          tab.cursorHistory.push(tab.cursor);
        }
      }
      tab.cursor = data.nextCursor;
    }

    if (!data.rows || data.rows.length === 0) {
      tableView.innerHTML = '<div class="empty-state"><p>Table ' + tab.tableName + ' is empty</p></div>';
      pagination.style.display = 'none';
      tab.data = null;
      return;
    }

    renderTable(data);
    renderPagination();
  } catch (error) {
    tableView.innerHTML = '<div class="error-state"><p>Error: ' + error.message + '</p></div>';
    pagination.style.display = 'none';
  } finally {
    hideLoading();
  }
}

function renderTable(data) {
  const tab = getActiveTab();
  if (!tab) return;

  const columns = Object.keys(data.rows[0] || {});

  if (!tab.limit) {
    tab.limit = 100; // Default limit for existing tabs
  }

  const tableHeader = document.createElement('div');
  tableHeader.className = 'table-header';
  const startRow = ((tab.page - 1) * tab.limit) + 1;
  const endRow = Math.min(tab.page * tab.limit, tab.totalCount);
  const totalRows = tab.totalCount;

  tableHeader.innerHTML = `
    <div class="table-header-left">
      <h2>${tab.tableName}</h2>
      <div class="table-header-actions">
        <button class="refresh-button" id="refreshButton" title="Refresh data">
          <svg class="refresh-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 2V6M8 14V10M2 8H6M10 8H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M2.5 5.5C3.1 4.2 4.1 3.2 5.4 2.6M13.5 10.5C12.9 11.8 11.9 12.8 10.6 13.4M5.5 2.5C4.2 3.1 3.2 4.1 2.6 5.4M10.5 13.5C11.8 12.9 12.8 11.9 13.4 10.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span class="refresh-text">Refresh</span>
        </button>
        <div class="limit-selector">
          <select id="limitSelect" class="limit-select" title="Rows per page">
            <option value="25" ${tab.limit === 25 ? 'selected' : ''}>25 rows</option>
            <option value="50" ${tab.limit === 50 ? 'selected' : ''}>50 rows</option>
            <option value="100" ${tab.limit === 100 ? 'selected' : ''}>100 rows</option>
            <option value="200" ${tab.limit === 200 ? 'selected' : ''}>200 rows</option>
            <option value="500" ${tab.limit === 500 ? 'selected' : ''}>500 rows</option>
          </select>
        </div>
        <div class="column-selector">
          <button class="column-button" id="columnButton" title="Show/Hide columns">
            <svg class="column-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M6 2V14M10 2V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class="column-label" id="columnLabel">Columns</span>
          </button>
          <div class="column-menu" id="columnMenu" style="display: none;">
            <div class="column-menu-header">Columns</div>
            <div class="column-menu-options" id="columnMenuOptions"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="row-info-container">
      <span class="row-info">
        <span class="row-info-range">${startRow.toLocaleString()}–${endRow.toLocaleString()}</span>
        <span class="row-info-separator">of</span>
        <span class="row-info-total">${totalRows.toLocaleString()}</span>
        ${tab.isApproximate ? '<span class="row-info-approx">(approx.)</span>' : ''}
      </span>
    </div>
  `;

  const refreshButton = tableHeader.querySelector('#refreshButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', handleRefresh);
  }

  const limitSelect = tableHeader.querySelector('#limitSelect');
  if (limitSelect) {
    limitSelect.addEventListener('change', (e) => {
      const newLimit = parseInt(e.target.value, 10);
      if (tab.limit !== newLimit) {
        tab.limit = newLimit;
        tab.page = 1; // Reset to first page when limit changes
        tab.cursor = null; // Reset cursor
        tab.cursorHistory = [];
        tab.data = null; // Clear cache
        loadTableData();
      }
    });
  }

  if (!tab.hiddenColumns) {
    tab.hiddenColumns = [];
  }

  if (!tab.columnWidths) {
    tab.columnWidths = {};
  }

  setupColumnSelector(tab, columns, tableHeader);
  updateColumnButtonLabel(tab, columns, tableHeader);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'table-container';

  const table = document.createElement('table');

  const visibleColumns = columns.filter(col => !tab.hiddenColumns.includes(col));

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  visibleColumns.forEach((column, index) => {
    const th = document.createElement('th');
    th.className = 'sortable resizable';
    th.dataset.column = column;

    if (tab.columnWidths[column]) {
      th.style.width = `${tab.columnWidths[column]}px`;
      th.style.minWidth = `${tab.columnWidths[column]}px`;
    } else {
      th.style.minWidth = '120px';
    }

    const columnHeader = document.createElement('div');
    columnHeader.className = 'column-header';

    // Column name with key badges
    const columnNameRow = document.createElement('div');
    columnNameRow.className = 'column-name-row';

    const columnName = document.createElement('div');
    columnName.className = 'column-name';
    columnName.textContent = column;
    columnNameRow.appendChild(columnName);

    const columnMeta = data.columns && data.columns[column] ? data.columns[column] : null;

    let dataType = '';
    let isPrimaryKey = false;
    let isForeignKey = false;
    let foreignKeyRef = null;
    let isUnique = false;

    if (columnMeta) {
      if (typeof columnMeta === 'string') {
        dataType = columnMeta;
      } else {
        dataType = columnMeta.dataType || '';
        isPrimaryKey = columnMeta.isPrimaryKey || false;
        isForeignKey = columnMeta.isForeignKey || false;
        foreignKeyRef = columnMeta.foreignKeyRef || null;
        isUnique = columnMeta.isUnique || false;
      }
    }

    const keyBadges = document.createElement('div');
    keyBadges.className = 'key-badges';

    if (isPrimaryKey) {
      const pkBadge = document.createElement('span');
      pkBadge.className = 'key-badge key-badge-pk';
      pkBadge.textContent = 'PK';
      pkBadge.title = 'Primary Key';
      keyBadges.appendChild(pkBadge);
    }

    if (isForeignKey && foreignKeyRef) {
      const fkBadge = document.createElement('span');
      fkBadge.className = 'key-badge key-badge-fk';
      fkBadge.textContent = 'FK';
      fkBadge.title = `Foreign Key → ${foreignKeyRef.table}.${foreignKeyRef.column}`;
      keyBadges.appendChild(fkBadge);
    }

    if (isUnique && !isPrimaryKey) {
      const uqBadge = document.createElement('span');
      uqBadge.className = 'key-badge key-badge-uq';
      uqBadge.textContent = 'UQ';
      uqBadge.title = 'Unique Constraint';
      keyBadges.appendChild(uqBadge);
    }

    if (keyBadges.children.length > 0) {
      columnNameRow.appendChild(keyBadges);
    }

    // Column datatype
    const columnDatatype = document.createElement('div');
    columnDatatype.className = 'column-datatype';
    columnDatatype.textContent = dataType;

    columnHeader.appendChild(columnNameRow);
    columnHeader.appendChild(columnDatatype);
    th.appendChild(columnHeader);

    if (tab.sortColumn === column) {
      th.classList.add(`sorted-${tab.sortDirection}`);
    }

    const sortIndicator = document.createElement('span');
    sortIndicator.className = 'sort-indicator';
    if (tab.sortColumn === column) {
      sortIndicator.textContent = tab.sortDirection === 'asc' ? ' ↑' : ' ↓';
      th.appendChild(sortIndicator);
    }

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startResize(e, column, th, tab);
    });
    th.appendChild(resizeHandle);

    th.addEventListener('click', (e) => {
      if (!e.target.classList.contains('resize-handle')) {
        handleSort(column);
      }
    });

    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Server-side sorting, so rows are already sorted
  const rows = data.rows || [];

  rows.forEach(row => {
    const tr = document.createElement('tr');
    visibleColumns.forEach(column => {
      const td = document.createElement('td');

      if (tab.columnWidths[column]) {
        td.style.width = `${tab.columnWidths[column]}px`;
        td.style.minWidth = `${tab.columnWidths[column]}px`;
      } else {
        td.style.minWidth = '120px';
      }

      const value = row[column];

      // Store original value for popup
      td.dataset.originalValue = value !== null && value !== undefined
        ? (isJsonValue(value) ? JSON.stringify(value, null, 2) : String(value))
        : 'NULL';
      td.dataset.columnName = column;

      td.addEventListener('click', (e) => {
        e.stopPropagation();
        showCellContentPopup(column, value);
      });

      td.style.cursor = 'pointer';

      if (value === null || value === undefined) {
        const nullSpan = document.createElement('span');
        nullSpan.className = 'null-value';
        nullSpan.textContent = 'NULL';
        td.appendChild(nullSpan);
      } else if (isJsonValue(value)) {
        const jsonPre = document.createElement('pre');
        jsonPre.className = 'json-value';
        try {
          jsonPre.textContent = JSON.stringify(value, null, 2);
        } catch (e) {
          jsonPre.textContent = String(value);
        }
        td.appendChild(jsonPre);
      } else {
        td.textContent = String(value);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);

  tableView.innerHTML = '';
  tableView.appendChild(tableHeader);
  tableView.appendChild(tableContainer);
}

function updateColumnButtonLabel(tab, columns, tableHeader) {
  const columnLabel = tableHeader ? tableHeader.querySelector('#columnLabel') : null;
  if (!columnLabel) return;

  const visibleCount = columns.length - (tab.hiddenColumns ? tab.hiddenColumns.length : 0);
  const totalCount = columns.length;

  if (visibleCount === totalCount) {
    columnLabel.textContent = 'Columns (All)';
  } else {
    columnLabel.textContent = `Columns (${visibleCount})`;
  }
}

function setupColumnSelector(tab, columns, tableHeader) {
  const columnButton = tableHeader.querySelector('#columnButton');
  const columnMenu = tableHeader.querySelector('#columnMenu');
  const columnMenuOptions = tableHeader.querySelector('#columnMenuOptions');
  const columnMenuHeader = tableHeader.querySelector('.column-menu-header');

  if (!columnButton || !columnMenu || !columnMenuOptions) {
    console.warn('Column selector elements not found');
    return;
  }

  columnMenuOptions.innerHTML = '';

  // Check if any columns are hidden
  const hasHiddenColumns = tab.hiddenColumns && tab.hiddenColumns.length > 0;

  if (columnMenuHeader) {
    let headerTitle = columnMenuHeader.querySelector('.column-menu-header-title');
    if (!headerTitle) {
      const headerText = columnMenuHeader.textContent.trim();
      columnMenuHeader.innerHTML = '';
      headerTitle = document.createElement('span');
      headerTitle.className = 'column-menu-header-title';
      headerTitle.textContent = headerText || 'Columns';
      columnMenuHeader.appendChild(headerTitle);
    }

    let selectAllButton = columnMenuHeader.querySelector('.column-select-all-button');
    if (hasHiddenColumns) {
      if (!selectAllButton) {
        selectAllButton = document.createElement('button');
        selectAllButton.className = 'column-select-all-button';
        selectAllButton.textContent = 'Select All';
        selectAllButton.title = 'Show all columns';
        selectAllButton.addEventListener('click', (e) => {
          e.stopPropagation();
          // Show all columns
          tab.hiddenColumns = [];
          if (tab.data) {
            renderTable(tab.data);
            requestAnimationFrame(() => {
              const newTableHeader = document.querySelector('.table-header');
              if (newTableHeader) {
                const newColumnMenu = newTableHeader.querySelector('#columnMenu');
                if (newColumnMenu) {
                  newColumnMenu.style.display = 'block';
                  const columns = Object.keys(tab.data.rows[0] || {});
                  setupColumnSelector(tab, columns, newTableHeader);
                  updateColumnButtonLabel(tab, columns, newTableHeader);
                }
              }
            });
          }
        });
        columnMenuHeader.appendChild(selectAllButton);
      }
      selectAllButton.style.display = 'block';
    } else if (selectAllButton) {
      selectAllButton.style.display = 'none';
    }
  }

  columns.forEach(column => {
    const label = document.createElement('label');
    label.className = 'column-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !tab.hiddenColumns.includes(column);
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleColumnVisibility(tab, column, checkbox.checked);
    });

    const span = document.createElement('span');
    span.textContent = column;

    label.appendChild(checkbox);
    label.appendChild(span);
    columnMenuOptions.appendChild(label);
  });

  const newColumnButton = columnButton.cloneNode(true);
  columnButton.parentNode.replaceChild(newColumnButton, columnButton);

  newColumnButton.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = tableHeader.querySelector('#columnMenu');
    if (menu) {
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
  });

  const closeMenuHandler = (e) => {
    const button = tableHeader.querySelector('#columnButton');
    const menu = tableHeader.querySelector('#columnMenu');
    if (button && menu && !button.contains(e.target) && !menu.contains(e.target)) {
      menu.style.display = 'none';
    }
  };

  document.removeEventListener('click', closeMenuHandler);
  document.addEventListener('click', closeMenuHandler);
}

function toggleColumnVisibility(tab, column, visible) {
  if (visible) {
    tab.hiddenColumns = tab.hiddenColumns.filter(col => col !== column);
  } else {
    if (!tab.hiddenColumns.includes(column)) {
      tab.hiddenColumns.push(column);
    }
  }

  const tableHeader = document.querySelector('.table-header');
  const columnMenu = tableHeader ? tableHeader.querySelector('#columnMenu') : null;
  const wasMenuOpen = columnMenu && columnMenu.style.display === 'block';

  if (tab.data) {
    renderTable(tab.data);

    if (wasMenuOpen) {
      requestAnimationFrame(() => {
        const newTableHeader = document.querySelector('.table-header');
        if (newTableHeader) {
          const newColumnMenu = newTableHeader.querySelector('#columnMenu');
          if (newColumnMenu) {
            newColumnMenu.style.display = 'block';
            const columns = Object.keys(tab.data.rows[0] || {});
            setupColumnSelector(tab, columns, newTableHeader);
            updateColumnButtonLabel(tab, columns, newTableHeader);
          }
        }
      });
    } else {
      requestAnimationFrame(() => {
        const newTableHeader = document.querySelector('.table-header');
        if (newTableHeader) {
          const columns = Object.keys(tab.data.rows[0] || {});
          updateColumnButtonLabel(tab, columns, newTableHeader);
        }
      });
    }
  }
}

let isResizing = false;
let currentResizeColumn = null;
let currentResizeTh = null;
let currentResizeTab = null;
let startX = 0;
let startWidth = 0;

function startResize(e, column, th, tab) {
  isResizing = true;
  currentResizeColumn = column;
  currentResizeTh = th;
  currentResizeTab = tab;
  startX = e.pageX;
  startWidth = th.offsetWidth;

  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  e.preventDefault();
}

function handleResize(e) {
  if (!isResizing) return;

  const diff = e.pageX - startX;
  const newWidth = Math.max(80, startWidth + diff); // Minimum width of 80px

  // Update the header
  if (currentResizeTh) {
    currentResizeTh.style.width = `${newWidth}px`;
    currentResizeTh.style.minWidth = `${newWidth}px`;
  }

  // Update all corresponding cells
  const table = currentResizeTh?.closest('table');
  if (table) {
    const columnIndex = Array.from(currentResizeTh.parentNode.children).indexOf(currentResizeTh);
    const allRows = table.querySelectorAll('tbody tr');
    allRows.forEach(row => {
      const cell = row.children[columnIndex];
      if (cell) {
        cell.style.width = `${newWidth}px`;
        cell.style.minWidth = `${newWidth}px`;
      }
    });
  }
}

function stopResize() {
  if (isResizing && currentResizeColumn && currentResizeTab && currentResizeTh) {
    const finalWidth = currentResizeTh.offsetWidth;
    currentResizeTab.columnWidths[currentResizeColumn] = finalWidth;
  }

  isResizing = false;
  currentResizeColumn = null;
  currentResizeTh = null;
  currentResizeTab = null;

  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

function handleSort(column) {
  const tab = getActiveTab();
  if (!tab) return;

  if (tab.sortColumn === column) {
    tab.sortDirection = tab.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    tab.sortColumn = column;
    tab.sortDirection = 'asc';
  }

  // Reload data from server with new sort
  tab.page = 1; // Reset to page 1 on sort change
  tab.cursor = null;
  tab.cursorHistory = [];
  loadTableData();
}

/**
 * Sort rows client-side based on current tab's sort settings.
 * Note: This sorts only the current page of data, not the entire table.
 * For full-table sorting, server-side sorting would be required.
 * @param {Array} rows - Array of row objects to sort
 * @param {Object} tab - Tab object with sortColumn and sortDirection
 * @returns {Array} Sorted array of rows
 */
function getSortedRows(rows, tab) {
  if (!rows || rows.length === 0) return [];
  if (!tab.sortColumn) return rows;

  const sorted = [...rows].sort((a, b) => {
    const aVal = a[tab.sortColumn];
    const bVal = b[tab.sortColumn];

    // Null/undefined values go to the end
    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;

    // Numeric comparison
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return tab.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }

    let aStr, bStr;
    if (isJsonValue(aVal)) {
      try {
        aStr = JSON.stringify(aVal).toLowerCase();
      } catch (e) {
        aStr = String(aVal).toLowerCase();
      }
    } else {
      aStr = String(aVal).toLowerCase();
    }

    if (isJsonValue(bVal)) {
      try {
        bStr = JSON.stringify(bVal).toLowerCase();
      } catch (e) {
        bStr = String(bVal).toLowerCase();
      }
    } else {
      bStr = String(bVal).toLowerCase();
    }

    if (tab.sortDirection === 'asc') {
      return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    } else {
      return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
    }
  });

  return sorted;
}

function renderPagination() {
  const tab = getActiveTab();
  if (!tab) return;

  if (!tab.limit) {
    tab.limit = 100; // Default limit for existing tabs
  }
  const limit = tab.limit;
  const totalPages = Math.ceil(tab.totalCount / limit);

  if (totalPages <= 1) {
    pagination.style.display = 'none';
    return;
  }

  pagination.style.display = 'flex';

  const hasPrevious = tab.page > 1;
  const hasNext = tab.page < totalPages;

  const startRow = ((tab.page - 1) * limit) + 1;
  const endRow = Math.min(tab.page * limit, tab.totalCount);

  pagination.innerHTML = `
    <div class="pagination-content">
      <button 
        class="pagination-button pagination-button-prev" 
        ${!hasPrevious ? 'disabled' : ''}
        onclick="handlePageChange(${tab.page - 1})"
        title="Previous page"
      >
        <svg class="pagination-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Previous</span>
      </button>
      <div class="pagination-info-container">
        <span class="pagination-info">
          <span class="pagination-page">Page <strong>${tab.page}</strong> of <strong>${totalPages}</strong></span>
          <span class="pagination-separator">•</span>
          <span class="pagination-rows">${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${tab.totalCount.toLocaleString()}</span>
        </span>
      </div>
      <button 
        class="pagination-button pagination-button-next" 
        ${!hasNext ? 'disabled' : ''}
        onclick="handlePageChange(${tab.page + 1})"
        title="Next page"
      >
        <span>Next</span>
        <svg class="pagination-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 12L10 8L6 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `;
}

/**
 * Handle page change in pagination.
 * Manages cursor-based pagination for forward navigation.
 * Falls back to offset-based pagination for backward navigation or page jumps.
 * @param {number} newPage - Page number to navigate to
 */
function handlePageChange(newPage) {
  const tab = getActiveTab();
  if (!tab) return;

  const oldPage = tab.page;
  tab.page = newPage;

  // Handle cursor-based pagination
  if (tab.hasPrimaryKey) {
    if (newPage < oldPage) {
      // Backward navigation - reset cursor (limitation: would need full cursor history for optimal backward nav)
      if (newPage === 1) {
        tab.cursor = null;
        tab.cursorHistory = [];
      } else {
        tab.cursor = null; // Falls back to OFFSET-based pagination
      }
    } else if (newPage === oldPage + 1) {
      // Forward navigation - cursor is already set from previous load
    } else {
      // Page jump - reset cursor
      tab.cursor = null;
      tab.cursorHistory = [];
    }
  }

  tab.data = null; // Clear cache to force reload
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadTableData();
}

window.handlePageChange = handlePageChange;

/**
 * Check if a value is a date/time value and parse it.
 * Detects Date objects, ISO date strings, and PostgreSQL timestamp strings.
 * @param {*} value - Value to check
 * @returns {Date|null} Parsed Date object if valid date/time, null otherwise
 */
function isDateTimeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'NULL') {
      return null;
    }

    // Try parsing as ISO date string or PostgreSQL timestamp
    // PostgreSQL timestamps: '2024-01-01 12:00:00' or '2024-01-01 12:00:00.123' or with timezone
    // ISO strings: '2024-01-01T12:00:00' or '2024-01-01T12:00:00Z' or with timezone offset
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      const datePattern = /^\d{4}-\d{2}-\d{2}/;
      if (datePattern.test(trimmed)) {
        return date;
      }
    }
  }

  return null;
}

/**
 * Get user's current timezone.
 * @returns {string} IANA timezone identifier (e.g., 'America/New_York')
 */
function getCurrentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {
    return 'UTC';
  }
}

/**
 * Get list of common timezones.
 * @returns {Array<{value: string, label: string}>} Array of timezone objects
 */
function getCommonTimezones() {
  const timezones = [
    { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
    { value: 'America/New_York', label: 'America/New_York (EST/EDT)' },
    { value: 'America/Chicago', label: 'America/Chicago (CST/CDT)' },
    { value: 'America/Denver', label: 'America/Denver (MST/MDT)' },
    { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST/PDT)' },
    { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
    { value: 'Europe/Paris', label: 'Europe/Paris (CET/CEST)' },
    { value: 'Europe/Berlin', label: 'Europe/Berlin (CET/CEST)' },
    { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
    { value: 'Asia/Shanghai', label: 'Asia/Shanghai (CST)' },
    { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
    { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
    { value: 'Australia/Sydney', label: 'Australia/Sydney (AEDT/AEST)' },
    { value: 'Pacific/Auckland', label: 'Pacific/Auckland (NZDT/NZST)' },
  ];

  // Add current timezone if not already in list
  const currentTz = getCurrentTimezone();
  const hasCurrent = timezones.some(tz => tz.value === currentTz);
  if (!hasCurrent && currentTz !== 'UTC') {
    timezones.unshift({ value: currentTz, label: `${currentTz} (Current)` });
  }

  return timezones;
}

/**
 * Format date/time in specified timezone.
 * @param {Date} date - Date object to format
 * @param {string} timezone - IANA timezone identifier
 * @returns {string} Formatted date/time string with timezone info
 */
function formatDateTimeInTimezone(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const second = parts.find(p => p.type === 'second').value;
    const fractionalSecond = parts.find(p => p.type === 'fractionalSecond')?.value || '';

    const tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const tzParts = tzFormatter.formatToParts(date);
    const tzName = tzParts.find(p => p.type === 'timeZoneName')?.value || timezone;

    const dateStr = `${year}-${month}-${day}`;
    const timeStr = `${hour}:${minute}:${second}${fractionalSecond ? '.' + fractionalSecond : ''}`;

    return `${dateStr} ${timeStr} ${tzName}`;
  } catch (e) {
    return date.toISOString();
  }
}

/**
 * Format cell content for display in popup dialog.
 * Handles JSON values, null values, JSON strings, date/time values, and regular text appropriately.
 * @param {*} value - The cell value to format
 * @returns {Object} Object with formatted content, isJson flag, isDateTime flag, and dateValue: { content: string, isJson: boolean, isDateTime: boolean, dateValue: Date | null }
 */
function formatCellContentForPopup(value, timezone = null) {
  if (value === null || value === undefined) {
    return { content: 'NULL', isJson: false, isDateTime: false, dateValue: null };
  }

  const dateValue = isDateTimeValue(value);
  if (dateValue) {
    const tz = timezone || getCurrentTimezone();
    const formatted = formatDateTimeInTimezone(dateValue, tz);
    return { content: formatted, isJson: false, isDateTime: true, dateValue: dateValue };
  }

  // Handle JSON objects/arrays
  if (isJsonValue(value)) {
    try {
      return { content: JSON.stringify(value, null, 2), isJson: true, isDateTime: false, dateValue: null };
    } catch (e) {
      return { content: String(value), isJson: false, isDateTime: false, dateValue: null };
    }
  }

  // Handle string values - check if it's a JSON string
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Check if string looks like JSON (starts with { or [)
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return { content: JSON.stringify(parsed, null, 2), isJson: true, isDateTime: false, dateValue: null };
      } catch (e) {
        return { content: String(value), isJson: false, isDateTime: false, dateValue: null };
      }
    }
  }

  return { content: String(value), isJson: false, isDateTime: false, dateValue: null };
}

/**
 * Show popup dialog with full cell content.
 * @param {string} column - Column name
 * @param {*} value - Cell value
 */
function showCellContentPopup(column, value) {
  closeCellContentPopup();

  const overlay = document.createElement('div');
  overlay.className = 'cell-popup-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeCellContentPopup();
    }
  });

  const dialog = document.createElement('div');
  dialog.className = 'cell-popup-dialog';
  dialog.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const formatted = formatCellContentForPopup(value);
  const formattedContent = formatted.content;
  const isJson = formatted.isJson;
  const isDateTime = formatted.isDateTime;

  const header = document.createElement('div');
  header.className = 'cell-popup-header';

  const title = document.createElement('h3');
  title.className = 'cell-popup-title';
  title.textContent = column;
  header.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'cell-popup-actions';

  const copyButton = document.createElement('button');
  copyButton.className = 'cell-popup-copy';
  copyButton.innerHTML = '📋';
  copyButton.title = 'Copy to clipboard';

  const updateContent = () => {
    let contentToDisplay = '';
    let contentToCopy = '';

    if (value === null || value === undefined) {
      content.classList.add('null-content');
      content.classList.remove('json-value-popup', 'datetime-value-popup');
      contentToDisplay = 'NULL';
      contentToCopy = 'NULL';
    } else if (isJson) {
      const formatted = formatCellContentForPopup(value);
      content.classList.add('json-value-popup');
      content.classList.remove('null-content', 'datetime-value-popup');
      contentToDisplay = formatted.content;
      contentToCopy = formatted.content;
    } else if (isDateTime) {
      // Display original date/time value without timezone conversion
      content.classList.add('datetime-value-popup');
      content.classList.remove('null-content', 'json-value-popup');
      contentToDisplay = String(value);
      contentToCopy = String(value);
    } else {
      const formatted = formatCellContentForPopup(value);
      content.classList.remove('null-content', 'json-value-popup', 'datetime-value-popup');
      contentToDisplay = formatted.content;
      contentToCopy = formatted.content;
    }

    content.textContent = contentToDisplay;
    copyButton._formattedContent = contentToCopy;
  };

  copyButton.addEventListener('click', async () => {
    try {
      const textToCopy = copyButton._formattedContent || formattedContent;
      await navigator.clipboard.writeText(textToCopy);
      copyButton.innerHTML = '✓';
      copyButton.title = 'Copied!';
      copyButton.classList.add('copied');
      setTimeout(() => {
        copyButton.innerHTML = '📋';
        copyButton.title = 'Copy to clipboard';
        copyButton.classList.remove('copied');
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      copyButton.innerHTML = '✗';
      copyButton.title = 'Copy failed';
      setTimeout(() => {
        copyButton.innerHTML = '📋';
        copyButton.title = 'Copy to clipboard';
      }, 2000);
    }
  });
  copyButton._formattedContent = formattedContent;
  headerActions.appendChild(copyButton);

  const closeButton = document.createElement('button');
  closeButton.className = 'cell-popup-close';
  closeButton.innerHTML = '×';
  closeButton.title = 'Close';
  closeButton.addEventListener('click', closeCellContentPopup);
  headerActions.appendChild(closeButton);

  header.appendChild(headerActions);

  const body = document.createElement('div');
  body.className = 'cell-popup-body';

  const content = document.createElement('pre');
  content.className = 'cell-popup-content';

  updateContent();

  body.appendChild(content);

  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);

  document.body.appendChild(overlay);

  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      closeCellContentPopup();
    }
  };
  overlay.dataset.escapeHandler = 'true';
  document.addEventListener('keydown', escapeHandler);

  overlay._escapeHandler = escapeHandler;
}

/**
 * Close the cell content popup dialog.
 */
function closeCellContentPopup() {
  const overlay = document.querySelector('.cell-popup-overlay');
  if (overlay) {
    if (overlay._escapeHandler) {
      document.removeEventListener('keydown', overlay._escapeHandler);
    }
    overlay.remove();
  }
}

function showLoading() {
  if (loadingOverlay) {
    loadingOverlay.style.display = 'flex';
  }
}

function hideLoading() {
  if (loadingOverlay) {
    loadingOverlay.style.display = 'none';
  }
}
