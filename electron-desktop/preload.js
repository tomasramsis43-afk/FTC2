// جسر آمن بين الواجهة (معزولة تماماً: contextIsolation + sandbox) وعملية Electron
// الرئيسية. لا يكشف أي صلاحية نظام ملفات عامة — فقط اختيار مجلد الإيصالات وقراءته
// (يُستخدم في إعداد «مجلد حفظ إيصالات أركان»).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // يفتح نافذة اختيار مجلد ويعيد { ok, folder } (folder فقط عند النجاح)
  selectReceiptsFolder: () => ipcRenderer.invoke('select-receipts-folder'),
  // يعيد { ok, folder } بالمسار المحفوظ حالياً (قد يكون '')
  getReceiptsFolder: () => ipcRenderer.invoke('get-receipts-folder'),
  // يلغي المجلد المختار ويعود لمجلد التنزيلات الافتراضي
  clearReceiptsFolder: () => ipcRenderer.invoke('clear-receipts-folder'),
  // تذكّر بيانات الدخول: مشفّرة بحماية نظام التشغيل (safeStorage) داخل مجلد بيانات التطبيق
  saveLoginCreds: (username, password) => ipcRenderer.invoke('save-login-creds', username, password),
  // يعيد { ok, username, password } أو { ok:false } لو لا توجد بيانات محفوظة
  getLoginCreds: () => ipcRenderer.invoke('get-login-creds'),
  clearLoginCreds: () => ipcRenderer.invoke('clear-login-creds'),
});