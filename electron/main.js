const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');

let mainWindow;

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
}


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
