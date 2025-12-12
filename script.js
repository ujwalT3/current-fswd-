/* script.js - shared header/nav manager for Notion IQ
   - Renders nav links depending on logged-in state
   - Keeps behavior consistent across all pages
   - Include this file with <script src="script.js" defer></script> on every page
*/

(function () {
  // Wait for DOM
  function onReady(fn){
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(() => {
    // If page already contains a <nav> with <ul>, we'll replace its UL contents.
    const nav = document.querySelector('nav');
    if (!nav) return;

    // Create container if needed
    let ul = nav.querySelector('ul');
    if (!ul) {
      ul = document.createElement('ul');
      nav.appendChild(ul);
    }

    function isLoggedInFromStorage() {
      try {
        return sessionStorage.getItem('notioniq_logged_in') === '1';
      } catch (e) {
        return false;
      }
    }

    function getUserFromStorage() {
      try {
        return sessionStorage.getItem('notioniq_user') || null;
      } catch (e) {
        return null;
      }
    }

    // Check server session (best-effort) if client flag missing
    function checkServerSessionOnce() {
      if (isLoggedInFromStorage()) {
        renderNav(true, getUserFromStorage());
        return;
      }
      // Best-effort fetch; if it fails we still render signed-out nav.
      fetch('/api/me', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.authenticated) {
            try {
              sessionStorage.setItem('notioniq_logged_in', '1');
              if (data.user && data.user.name) sessionStorage.setItem('notioniq_user', data.user.name);
            } catch (e) {}
            renderNav(true, (data.user && data.user.name) || null);
          } else {
            renderNav(false, null);
          }
        })
        .catch(() => renderNav(false, null));
    }

    function createLiLink(href, text, isActive) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.textContent = text;
      if (isActive) a.classList.add('active');
      li.appendChild(a);
      return li;
    }

    function createSignOutLi(username) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = username ? `Hi, ${username} — Sign Out` : 'Sign Out';
      a.style.cursor = 'pointer';
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await fetch('/api/signout', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'} }); } catch (err) { /* ignore */ }
        try { sessionStorage.removeItem('notioniq_logged_in'); sessionStorage.removeItem('notioniq_user'); } catch(e){}
        // Re-render nav as signed-out and redirect to home
        renderNav(false, null);
        // if current page is a protected page, redirect to index
        const protectedPaths = ['/Notion.html', '/quiz.html', '/notion.html'];
        if (protectedPaths.includes(window.location.pathname)) window.location.href = 'index.html';
      });
      li.appendChild(a);
      return li;
    }

    function renderNav(loggedIn, username) {
      // Clear UL
      ul.innerHTML = '';

      // Determine active link by path or hash (supports index with #home)
      const path = window.location.pathname.replace(/^\/+/, '');
      const hash = window.location.hash || '';

      function isActive(href) {
        if (!href) return false;
        if (href.startsWith('#')) {
          // Home anchor on index.html
          if ((path === '' || path === 'index.html') && hash === href) return true;
          // also consider index home when path is index.html
          if ((path === '' || path === 'index.html') && href === '#home' && (hash === '' || hash === '#home')) return (hash === '#home' || hash === '');
          return false;
        }
        // Normalize
        const hrefPath = href.replace(/^\/+/, '');
        return (hrefPath === path) || (hrefPath === (path || 'index.html'));
      }

      // Core links: Home, About (always visible)
      // Home: on index.html it's '#home' anchor; on other pages use 'index.html'
      const homeHref = (window.location.pathname.replace(/^\/+/, '') === '' || window.location.pathname.endsWith('index.html')) ? '#home' : 'index.html';
      ul.appendChild(createLiLink(homeHref, 'Home', isActive(homeHref)));
      ul.appendChild(createLiLink('about.html', 'About', isActive('about.html')));

      // If logged in, show Notion and Quiz
      if (loggedIn) {
        ul.appendChild(createLiLink('Notion.html', 'Notion', isActive('Notion.html')));
        ul.appendChild(createLiLink('quiz.html', 'Quiz', isActive('quiz.html')));
      }

      // Right-most: Sign In (if logged out) OR Sign Out with username (if logged in)
      if (loggedIn) {
        // replace/add sign-out
        ul.appendChild(createSignOutLi(username));
      } else {
        ul.appendChild(createLiLink('signin.html', 'Sign In', isActive('signin.html')));
      }
    }

    // Initial render
    const alreadyLogged = isLoggedInFromStorage();
    if (alreadyLogged) renderNav(true, getUserFromStorage());
    else checkServerSessionOnce();

    // Expose small API if needed by other scripts
    window._NotionIQAuth = {
      renderNav,
      setLoggedInFlag: function(username){
        try { sessionStorage.setItem('notioniq_logged_in', '1'); if (username) sessionStorage.setItem('notioniq_user', username); } catch(e){}
        renderNav(true, username || getUserFromStorage());
      },
      setLoggedOutFlag: function(){
        try { sessionStorage.removeItem('notioniq_logged_in'); sessionStorage.removeItem('notioniq_user'); } catch(e){}
        renderNav(false, null);
      }
    };
  });
})();
