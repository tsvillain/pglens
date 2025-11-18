/**
 * pglens - PostgreSQL Database Viewer
 * 
 * Main client-side application for viewing PostgreSQL database tables.
 * Features:
 * - Multi-tab table viewing
 * - Client-side sorting and column management
 * - Cursor-based pagination for large tables
 * - Theme support (light/dark/system)
 * - Real-time table search
 */

// Application state
let tabs = []; // Array of tab objects: { tableName, page, totalCount, sortColumn, sortDirection, data, hiddenColumns, columnWidths, cursor, cursorHistory, hasPrimaryKey, isApproximate }
let activeTabIndex = -1; // Currently active tab index
let allTables = []; // All available tables from the database
let searchQuery = ''; // Current search filter for tables
let currentTheme = 'system'; // Current theme: 'light', 'dark', or 'system'
const sidebar = document.getElementById('sidebar');
const sidebarContent = sidebar.querySelector('.sidebar-content');
const tableCount = document.getElementById('tableCount');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarSearch = document.getElementById('sidebarSearch');
const themeButton = document.getElementById('themeButton');
const themeMenu = document.getElementById('themeMenu');
const tabsContainer = document.getElementById('tabsContainer');
const tabsBar = document.getElementById('tabsBar');
const tableView = document.getElementById('tableView');
const pagination = document.getElementById('pagination');

/**
 * Initialize the application when DOM is ready.
 * Sets up event listeners and loads initial data.
 */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadTables();

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
  if (tabs.length === 0) {
    sidebarToggle.disabled = true;
    sidebarToggle.classList.add('disabled');
    sidebar.classList.remove('minimized');
  } else {
    sidebarToggle.disabled = false;
    sidebarToggle.classList.remove('disabled');
  }
}

/**
 * Load all tables from the database via API.
 * Fetches table list and updates the sidebar.
 */
async function loadTables() {
  try {
    sidebarContent.innerHTML = '<div class="loading">Loading tables...</div>';
    const response = await fetch('/api/tables');
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
  const activeTable = getActiveTab()?.tableName;
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
  const existingTabIndex = tabs.findIndex(tab => tab.tableName === tableName);

  if (existingTabIndex !== -1) {
    switchToTab(existingTabIndex);
  } else {
    const newTab = {
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
      isApproximate: false // Whether count is approximate (for large tables)
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

  const tableItems = sidebarContent.querySelectorAll('.table-list li');
  tableItems.forEach(item => {
    if (item.textContent === tab.tableName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

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

  if (tabs.length <= 1) {
    tabs = [];
    activeTabIndex = -1;
    tabsContainer.style.display = 'none';
    tableView.innerHTML = '<div class="empty-state"><p>Select a table from the sidebar to view its data</p></div>';
    pagination.style.display = 'none';

    const tableItems = sidebarContent.querySelectorAll('.table-list li');
    tableItems.forEach(item => item.classList.remove('active'));

    updateSidebarToggleState();
    return;
  }

  tabs.splice(index, 1);

  if (activeTabIndex >= index) {
    activeTabIndex--;
    if (activeTabIndex < 0) activeTabIndex = 0;
  }

  if (index === activeTabIndex || activeTabIndex >= tabs.length) {
    activeTabIndex = Math.max(0, tabs.length - 1);
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
    updateSidebarToggleState();
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

  const tableItems = sidebarContent.querySelectorAll('.table-list li');
  tableItems.forEach(item => item.classList.remove('active'));

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

  const refreshIcon = document.querySelector('.refresh-icon');
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
    tableView.innerHTML = '<div class="loading-state"><p>Loading data from ' + tab.tableName + '...</p></div>';

    // Build query with cursor-based pagination if available
    let queryString = `page=${tab.page}&limit=100`;
    if (tab.hasPrimaryKey && tab.cursor && tab.page > 1) {
      // Use cursor for forward navigation (more efficient than OFFSET)
      queryString += `&cursor=${encodeURIComponent(tab.cursor)}`;
    }

    const response = await fetch(`/api/tables/${tab.tableName}?${queryString}`);
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
  }
}

function renderTable(data) {
  const tab = getActiveTab();
  if (!tab) return;

  const columns = Object.keys(data.rows[0] || {});

  const tableHeader = document.createElement('div');
  tableHeader.className = 'table-header';
  tableHeader.innerHTML = `
    <div class="table-header-left">
      <h2>${tab.tableName}</h2>
      <button class="refresh-button" id="refreshButton" title="Refresh data">
        <span class="refresh-icon">↻</span>
      </button>
      <div class="column-selector">
        <button class="column-button" id="columnButton" title="Show/Hide columns">
          <span class="column-label" id="columnLabel">Columns</span>
        </button>
        <div class="column-menu" id="columnMenu" style="display: none;">
          <div class="column-menu-header">Columns</div>
          <div class="column-menu-options" id="columnMenuOptions"></div>
        </div>
      </div>
    </div>
    <span class="row-info">
      Showing ${((tab.page - 1) * 100) + 1}-${Math.min(tab.page * 100, tab.totalCount)} of ${tab.totalCount}${tab.isApproximate ? ' (approx.)' : ''} rows
    </span>
  `;

  const refreshButton = tableHeader.querySelector('#refreshButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', handleRefresh);
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
  const sortedRows = getSortedRows(data.rows, tab);

  sortedRows.forEach(row => {
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

      td.addEventListener('dblclick', (e) => {
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

  if (!columnButton || !columnMenu || !columnMenuOptions) {
    console.warn('Column selector elements not found');
    return;
  }

  columnMenuOptions.innerHTML = '';

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

  if (tab.data) {
    renderTable(tab.data);
  }
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

  const limit = 100;
  const totalPages = Math.ceil(tab.totalCount / limit);

  if (totalPages <= 1) {
    pagination.style.display = 'none';
    return;
  }

  pagination.style.display = 'flex';

  const hasPrevious = tab.page > 1;
  const hasNext = tab.page < totalPages;

  pagination.innerHTML = `
    <button 
      class="pagination-button" 
      ${!hasPrevious ? 'disabled' : ''}
      onclick="handlePageChange(${tab.page - 1})"
    >
      Previous
    </button>
    <span class="pagination-info">
      Page ${tab.page} of ${totalPages}
    </span>
    <button 
      class="pagination-button" 
      ${!hasNext ? 'disabled' : ''}
      onclick="handlePageChange(${tab.page + 1})"
    >
      Next
    </button>
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
 * Format cell content for display in popup dialog.
 * Handles JSON values, null values, JSON strings, and regular text appropriately.
 * @param {*} value - The cell value to format
 * @returns {Object} Object with formatted content and isJson flag: { content: string, isJson: boolean }
 */
function formatCellContentForPopup(value) {
  if (value === null || value === undefined) {
    return { content: 'NULL', isJson: false };
  }

  // Handle JSON objects/arrays
  if (isJsonValue(value)) {
    try {
      return { content: JSON.stringify(value, null, 2), isJson: true };
    } catch (e) {
      return { content: String(value), isJson: false };
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
        return { content: JSON.stringify(parsed, null, 2), isJson: true };
      } catch (e) {
        return { content: String(value), isJson: false };
      }
    }
  }

  return { content: String(value), isJson: false };
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
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(formattedContent);
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

  if (value === null || value === undefined) {
    content.classList.add('null-content');
    content.textContent = 'NULL';
  } else if (isJson) {
    content.classList.add('json-value-popup');
    content.textContent = formattedContent;
  } else {
    content.textContent = formattedContent;
  }

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
