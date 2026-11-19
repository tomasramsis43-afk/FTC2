/*
 * FTC2 - Preload script (contextBridge)
 * Exposes a minimal, safe window.desktopAPI to the renderer without
 * enabling nodeIntegration. Currently used for the "remember login"
 * feature (username + password), stored encrypted via safeStorage in
 * the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

const receiptApi = {
  // Receipts (إيصالات أركان)
  saveReceipt: (data) => ipcRenderer.invoke('ftc2-receipts:save', data),
  getReceiptsIndex: () => ipcRenderer.invoke('ftc2-receipts:index'),
  findReceipt: (payload) => ipcRenderer.invoke('ftc2-receipts:find', payload),
  printReceipt: (payload) => ipcRenderer.invoke('ftc2-receipts:print', payload),
  // طباعة دفعة إيصالات (دورة + حقيبة) لعدة عملاء: طابعة واحدة تُختار مرة واحدة
  listPrinters: () => ipcRenderer.invoke('ftc2-receipts:printers'),
  resolveReceiptBatch: (payload) => ipcRenderer.invoke('ftc2-receipts:resolve-batch', payload),
  printReceiptBatch: (payload) => ipcRenderer.invoke('ftc2-receipts:print-batch', payload),
  previewReceiptPrint: (payload) => ipcRenderer.invoke('ftc2-receipts:preview-print', payload),
  cancelReceiptBatch: () => ipcRenderer.invoke('ftc2-receipts:print-batch-cancel'),
  onReceiptBatchProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (event, data) => cb(data);
    ipcRenderer.on('ftc2-receipts:print-batch-progress', handler);
    return () => { try { ipcRenderer.removeListener('ftc2-receipts:print-batch-progress', handler); } catch (e) {} };
  },
  openReceipt: (payload) => ipcRenderer.invoke('ftc2-receipts:open-file', payload),
  exportReceipt: (payload) => ipcRenderer.invoke('ftc2-receipts:export', payload),
  exportReceiptBatch: (payload) => ipcRenderer.invoke('ftc2-receipts:export-batch', payload),
  openReceiptsFolder: (clientId, invoiceNo) => ipcRenderer.invoke('ftc2-receipts:open-folder', clientId, invoiceNo),
  openReceiptsBaseFolder: () => ipcRenderer.invoke('ftc2-receipts:open-base-folder'),
  getReceiptsFolder: () => ipcRenderer.invoke('ftc2-receipts:get-folder'),
  selectReceiptsFolder: () => ipcRenderer.invoke('ftc2-receipts:select-folder'),
  clearReceiptsFolder: () => ipcRenderer.invoke('ftc2-receipts:clear-folder'),
};

contextBridge.exposeInMainWorld('desktopAPI', Object.assign({
  getLoginCreds: () => ipcRenderer.invoke('ftc2-creds:get'),
  saveLoginCreds: (username, password) => ipcRenderer.invoke('ftc2-creds:save', username, password),
  clearLoginCreds: () => ipcRenderer.invoke('ftc2-creds:clear'),
}, receiptApi));

contextBridge.exposeInMainWorld('electronAPI', receiptApi);
