// Shared start of every page (map, print, upload). Loaded as an ordinary script at the top of <head>:
//   <script src="js/head.js" data-css="css/style.css css/print.css"></script>
// It writes, in this order:
//   1. the Google Fonts link (Noto families for the native scripts),
//   2. the last-used style version, put on before anything shows; the page stays hidden until the
//      style and its fonts are in (js/styles.js → reveal), never longer than 4 s,
//   3. the page's stylesheets (data-css), loaded fresh on every visit.
// And it defines two helpers the pages use:
//   atlasStart('app')  loads js/config.js, then js/app.js, both fresh; shows an error box if either fails;
//   atlasFail(error)   the error box: a code (E1…E6, explained in the README) and what went wrong.
(function () {
  var me = document.currentScript;
  var v = '?v=' + Date.now();
  var html = document.documentElement;

  document.write(
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,300..700;1,300..700' +
    '&family=Noto+Sans+Display:wght@400..700&family=Noto+Sans+Armenian&family=Noto+Sans+Georgian&family=Noto+Sans+Gurmukhi' +
    '&family=Noto+Sans+Devanagari&family=Noto+Sans+Arabic&family=Noto+Sans+Canadian+Aboriginal&display=swap">');

  html.classList.add('styling');
  setTimeout(function () { html.classList.remove('styling'); }, 4000); // never stay hidden
  try {
    var c = JSON.parse(localStorage.getItem('atlas-of-warmth-style-cache'));
    if (c) {
      for (var k in c.vars) html.style.setProperty(k, c.vars[k]);
      (c.fonts || []).forEach(function (f) {
        if (f.google) document.write('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=' + f.google + '&display=swap">');
        else if (f.file) document.write('<style>@font-face { font-family: \'' + f.family + '\'; src: url(\'' + f.file + '\'); font-weight: 100 900; }</style>');
      });
    }
  } catch (e) { /* no saved style: the built-in look shows */ }

  (me.getAttribute('data-css') || 'css/style.css').split(/\s+/).forEach(function (href) {
    if (href) document.write('<link rel="stylesheet" href="' + href + v + '">');
  });

  window.atlasFail = function (err) {
    console.error(err);
    var code = (err && err.code) || 'E6';
    var text = err && err.code ? err.message
      : 'The page stopped with an error in its code (' + ((err && err.message) || err) + '). ' +
        'If this started after an edit on GitHub, undo that edit.';
    html.classList.remove('styling');
    var box = document.querySelector('.fatal');
    if (!box) { box = document.createElement('div'); box.className = 'fatal'; box.setAttribute('role', 'alert'); document.body.appendChild(box); }
    box.innerHTML = '';
    var p = document.createElement('p');
    var s = document.createElement('strong');
    s.textContent = code;
    p.appendChild(s);
    p.appendChild(document.createTextNode(text));
    var small = document.createElement('small');
    small.textContent = 'The error codes are explained in README.md, under "When something goes wrong".';
    box.appendChild(p);
    box.appendChild(small);
  };

  window.atlasStart = function (entry) {
    import('./config.js' + v).then(
      function () { return import('./' + entry + '.js' + v); },
      function (err) {
        var e = new Error('The settings file js/config.js could not be read (' + err.message + '). ' +
          'A comma, bracket or quote is probably missing or extra. Open the file on GitHub, look at the last change ' +
          '(History), and correct or undo it.');
        e.code = 'E1';
        throw e;
      }
    ).catch(window.atlasFail);
  };
})();
