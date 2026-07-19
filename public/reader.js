'use strict';

/**
 * reader.js — article font-size controls for /read/:slug. External (not inline)
 * to satisfy the CSP `script-src 'self'` the v2 shell enforces. Theme toggle is
 * handled globally by /app.js.
 */
(function () {
  function init() {
    var article = document.querySelector('.reader-article');
    var btns = document.querySelectorAll('.reader-font-btn');
    if (!article || !btns.length) return;
    var saved = localStorage.getItem('heimdall-reader-size') || 'md';
    article.setAttribute('data-reader-size', saved);
    btns.forEach(function (b) {
      if (b.dataset.size === saved) b.classList.add('active');
      b.addEventListener('click', function () {
        var size = b.dataset.size;
        article.setAttribute('data-reader-size', size);
        localStorage.setItem('heimdall-reader-size', size);
        btns.forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
