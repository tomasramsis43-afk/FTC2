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
  // يفحص أي الأسماء محفوظة مسبقاً في مجلدها الهدف — يعيد { existing: [أسماء] }
  checkReceiptsExist: (fileNames) => ipcRenderer.invoke('check-receipts-exist', fileNames),
  // يسمح باستبدال (الكتابة فوق) هذه الأسماء عند التنزيل التالي لها — تُستهلك مرة واحدة
  allowReceiptsOverwrite: (fileNames) => ipcRenderer.invoke('allow-receipts-overwrite', fileNames),
});