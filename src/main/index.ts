import { BrowserWindow } from '@mobrowser/api';
const window = new BrowserWindow();
window.browser.loadUrl(
  'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      '<!doctype html><html><head><meta charset="utf-8"><title>Hello World</title></head><body style="font:24px system-ui;display:grid;place-content:center;height:90vh"><h1>Hello World</h1><p>Welcome to your MōBrowser app.</p></body></html>',
    ),
);
window.setSize({ width: 800, height: 600 });
window.show();
