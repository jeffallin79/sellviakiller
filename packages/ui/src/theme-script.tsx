/** Inline, render-blocking theme bootstrap (avoids a light flash for dark-mode users). */
export const THEME_STORAGE_KEY = 'sf-theme';
const code = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})();`;
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
