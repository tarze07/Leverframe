// The colors of the last theme (#115): the start screen matches the app (light themes too).
try {
  const c = JSON.parse(localStorage.getItem("leverframe.startColors") || "null");
  if (c && c.bg) document.documentElement.style.cssText = "background:" + c.bg + ";color:" + c.fg;
} catch {
  /* defaults */
}
