// A <meta> CSP cannot carry frame-ancestors and Bun serves this page without custom headers, so refuse to render when framed.
// Loaded before main.tsx; removing #root makes the app bootstrap fail instead of running inside a clickjacking frame.
if (window.top !== window.self) {
  document.documentElement.textContent = "Tapocalypse cannot be embedded in another page.";
}
