/* TEMA COMPARTILHADO · GBA MUSIC
   Carregado no <head> de todas as páginas.
   1) aplica o tema claro/escuro salvo (padrão: claro) antes de desenhar a página
   2) monta o menu lateral e o botão de tema */
(function () {
  var KEY = 'gba-tema', root = document.documentElement, tema = 'light';
  try { var s = localStorage.getItem(KEY); if (s === 'dark' || s === 'light') tema = s; } catch (e) {}
  root.setAttribute('data-theme', tema);

  var ICON = {
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
    metas: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    proj: '<rect x="4" y="12" width="4" height="8" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="16" y="9" width="4" height="11" rx="1"/>',
    redes: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>'
  };
  var ITEMS = [
    ['inicio.html', 'Início', ICON.home, 'Visão geral'],
    ['index.html', 'Metas', ICON.metas, 'Metas e vídeos (Dashboard)'],
    ['acompanhamento.html', 'Projetos', ICON.proj, 'Acompanhamento de projetos'],
    ['social.html', 'Redes', ICON.redes, 'Redes sociais']
  ];

  function montar() {
    var atual = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var nav = ITEMS.map(function (it) {
      var svg = '<svg viewBox="0 0 24 24">' + it[2] + '</svg><small>' + it[1] + '</small>';
      return it[0] === atual
        ? '<span class="gni on" title="' + it[3] + '" aria-current="page">' + svg + '</span>'
        : '<a class="gni" href="' + it[0] + '" title="' + it[3] + '">' + svg + '</a>';
    }).join('');
    var aside = document.createElement('aside');
    aside.className = 'gside';
    aside.innerHTML =
      '<a class="glg" href="inicio.html" title="GBA Music">GBA</a>' +
      '<nav aria-label="Páginas">' + nav + '</nav>' +
      '<button class="gtema" type="button" title="Alternar entre modo claro e escuro" aria-label="Alternar entre modo claro e escuro">' +
      '<svg class="moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>' +
      '<svg class="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>';
    document.body.insertBefore(aside, document.body.firstChild);
    aside.querySelector('.gtema').onclick = function () {
      var prox = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', prox);
      try { localStorage.setItem(KEY, prox); } catch (e) {}
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
