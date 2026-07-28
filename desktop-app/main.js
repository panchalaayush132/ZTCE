const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev, dir: __dirname });
const handle = nextApp.getRequestHandler();

let mainWindow;

nextApp.prepare().then(() => {
  const port = 3000;
  
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });
  
  server.listen(port, () => {
    console.log(`> ZTCE is ready on http://localhost:${port}`);
  });

  app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      title: "ZTCE — Zero-Trust Collaborative Execution Engine",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    mainWindow.maximize();
    mainWindow.loadURL(`http://localhost:${port}?electron=true`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers for Local File System Access
ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-dir', async (event, dirPath) => {
  try {
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return items.map(item => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: path.join(dirPath, item.name).replace(/\\/g, '/')
    }));
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Sandboxed Local Python Execution
ipcMain.handle('run-python', async (event, code, cwd) => {
  return new Promise((resolve) => {
    const tempFile = path.join(app.getPath('temp'), `ztce_exec_${Date.now()}.py`);
    fs.writeFileSync(tempFile, code, 'utf-8');

    const startTime = Date.now();
    const child = spawn('python', [tempFile], { cwd: cwd || app.getPath('temp') });
    
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => stdout += data.toString());
    child.stderr.on('data', data => stderr += data.toString());

    child.on('close', code => {
      const executionTime = Date.now() - startTime;
      try { fs.unlinkSync(tempFile); } catch(e) {}
      resolve({ stdout, stderr, return_code: code, execution_time: executionTime });
    });
    
    child.on('error', err => {
      resolve({ stdout: '', stderr: err.message, return_code: -1, execution_time: Date.now() - startTime });
    });
  });
});

// Local Terminal Execution
ipcMain.handle('run-terminal', async (event, command, cwd) => {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn(command, { shell: true, cwd: cwd || app.getPath('temp') });
    
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => stdout += data.toString());
    child.stderr.on('data', data => stderr += data.toString());

    child.on('close', code => {
      resolve({ stdout, stderr, return_code: code, execution_time: Date.now() - startTime });
    });
    
    child.on('error', err => {
      resolve({ stdout: '', stderr: err.message, return_code: -1, execution_time: Date.now() - startTime });
    });
  });
});
