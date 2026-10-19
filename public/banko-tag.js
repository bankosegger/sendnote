/*!
 * Usage:
 *   <script src="/banko-tag.js" defer
 *           data-href="https://yoursite.com"
 *           data-position="bottom-right"></script>
 *
 * data-href      optional. Overrides the link target (defaults to bankosegger.me, new tab).
 * data-position  optional. bottom-right (default) | bottom-left | top-right | top-left
 */
(function () {
  var script = document.currentScript;
  var href = (script && script.getAttribute('data-href')) || 'https://bankosegger.me';
  var position = (script && script.getAttribute('data-position')) || 'bottom-right';

  var pos = {
    'bottom-right': 'bottom:14px;right:14px;',
    'bottom-left': 'bottom:14px;left:14px;',
    'top-right': 'top:14px;right:14px;',
    'top-left': 'top:14px;left:14px;'
  }[position] || 'bottom:14px;right:14px;';

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;' + pos + 'z-index:2147483647;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var Tag = href ? 'a' : 'div';
  var tag = document.createElement(Tag);
  if (href) {
    tag.href = href;
    tag.target = '_blank';
    tag.rel = 'noopener noreferrer';
  }
  tag.className = 'tag';
  tag.setAttribute('aria-label', 'a banko production');
  tag.innerHTML =
    '<span class="mark">b</span>' +
    '<span class="label">a&nbsp;banko&nbsp;production</span>';

  var css = [
    ':host, *{box-sizing:border-box;}',
    '.tag{',
    '  all:unset;',
    '  display:inline-flex;align-items:center;',
    '  height:28px;',
    '  border-radius:14px;',
    '  background:rgba(14,15,16,.72);',
    '  border:1px solid rgba(255,255,255,.09);',
    '  backdrop-filter:blur(10px) saturate(120%);',
    '  -webkit-backdrop-filter:blur(10px) saturate(120%);',
    '  font:600 11px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;',
    '  letter-spacing:.02em;',
    '  color:#e8ecee;',
    '  cursor:' + (href ? 'pointer' : 'default') + ';',
    '  overflow:hidden;',
    '  width:28px;',
    '  transition:width .28s cubic-bezier(.2,.8,.2,1),background .2s ease;',
    '  will-change:width;',
    '}',
    '.tag:hover, .tag:focus-visible{',
    '  width:168px;',
    '  background:rgba(14,15,16,.88);',
    '}',
    '.mark{',
    '  flex:0 0 28px;width:28px;height:28px;',
    '  display:flex;align-items:center;justify-content:center;',
    '  font-family:Georgia,"Times New Roman",serif;',
    '  font-weight:700;font-style:italic;font-size:14px;',
    '  color:#e8ecee;',
    '}',
    '.label{',
    '  white-space:nowrap;',
    '  opacity:0;',
    '  transform:translateX(-4px);',
    '  transition:opacity .18s ease .05s,transform .18s ease .05s;',
    '  color:#b9c1c5;',
    '  padding-right:12px;',
    '}',
    '.tag:hover .label, .tag:focus-visible .label{',
    '  opacity:1;',
    '  transform:translateX(0);',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  .tag,.label{transition:none;}',
    '}'
  ].join('\n');

  // Constructed stylesheet: works under a strict style-src 'self' CSP,
  // unlike an inline <style> element.
  var sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [sheet];
  root.appendChild(tag);

  function mount() {
    document.body.appendChild(host);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
