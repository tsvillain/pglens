const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');
const { autoUpdater } = require('electron-updater');

let mainWindow;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

async function createWindow() {
    // Start the Express server in non-standalone mode (no process.exit)
    const port = await startServer({ standalone: false });

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'pglens',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    mainWindow.loadURL(`http://localhost:${port}`);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });

    mainWindow.webContents.once('did-finish-load', () => {
        checkForUpdates();
    });
}

function checkForUpdates() {
    autoUpdater.checkForUpdates().catch(err => {
        console.log('Update check failed:', err.message);
    });
}

autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. Would you like to download it now?`,
        buttons: ['Download', 'Later']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.downloadUpdate();
        }
    });
});

autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. The app will restart to install the update.',
        buttons: ['Restart Now', 'Later']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
});

autoUpdater.on('error', (err) => {
    console.log('Auto-updater error:', err.message);
});

if (process.platform === 'darwin') {
    app.setName('pglens');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (mainWindow === null) createWindow();
});
