/* Preview-only automation so headless screenshots can show menus and dialogs. */
const mode = new URLSearchParams(location.search).get('auto');

function waitFor(selector, callback, timeout = 4000) {
  const started = Date.now();
  const timer = setInterval(() => {
    const element = document.querySelector(selector);
    if (element) {
      clearInterval(timer);
      callback(element);
    } else if (Date.now() - started > timeout) {
      clearInterval(timer);
    }
  }, 80);
}

function keepMenuOpen(open, selector = '.menu') {
  const reopen = () => {
    if (!document.querySelector(selector)) open();
  };
  open();
  setInterval(reopen, 40);
  setTimeout(() => {
    window.addEventListener('resize', reopen);
    window.addEventListener('scroll', reopen, true);
  }, 0);
}

if (mode) {
  const readySelector =
    mode.startsWith('tabs') || mode.startsWith('tab-')
      ? '.tab-row'
      : mode.startsWith('popup')
        ? '.pop-group'
        : '.group-row';
  waitFor(readySelector, () => {
    setTimeout(() => {
      const firstRow = document.querySelector('.group-row');
      switch (mode) {
        case 'expand':
          firstRow?.querySelector('.expand-btn')?.click();
          break;
        case 'open-menu':
          keepMenuOpen(() => firstRow?.querySelector('[data-action="open-menu"]')?.click());
          break;
        case 'more-menu':
          keepMenuOpen(() => firstRow?.querySelector('[data-action="more-menu"]')?.click());
          break;
        case 'color-menu':
          keepMenuOpen(() => {
            firstRow?.querySelector('[data-action="more-menu"]')?.click();
            setTimeout(() => document.querySelectorAll('.menu-item')[1]?.click(), 120);
          });
          break;
        case 'dialog':
          document.querySelector('#newGroupMenuBtn')?.click();
          setTimeout(() => document.querySelector('.menu-item')?.click(), 140);
          break;
        case 'settings':
          document.querySelector('#settingsBtn')?.click();
          break;
        case 'picker':
          document.querySelector('#newGroupBtn')?.click();
          setTimeout(() => {
            const rows = [...document.querySelectorAll('.picker-row')];
            rows[0]?.click();
            rows[1]?.click();
            rows[3]?.click();
          }, 400);
          break;
        case 'popup-picker':
          document.querySelector('#newGroupBtn')?.click();
          setTimeout(() => {
            const rows = [...document.querySelectorAll('.picker-row')];
            rows[0]?.click();
            rows[2]?.click();
            rows[5]?.click();
          }, 400);
          break;
        case 'popup-menu':
          document.querySelector('#newGroupMenuBtn')?.click();
          break;
        case 'popup-group-menu':
          keepMenuOpen(
            () => document.querySelector('.pop-group [data-action="more"]')?.click(),
            '.pop-menu',
          );
          break;
        case 'popup-rename':
          document.querySelector('.pop-group [data-action="more"]')?.click();
          setTimeout(
            () => document.querySelector('.pop-menu-item')?.click(),
            180,
          );
          break;
        case 'select':
          document.querySelectorAll('.row-check')[0]?.click();
          document.querySelectorAll('.row-check')[1]?.click();
          document.querySelectorAll('.row-check')[2]?.click();
          break;
        case 'search': {
          const input = document.querySelector('#groupSearch');
          if (input) {
            input.value = 'react';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          break;
        }
        case 'tabs-select':
          document.querySelectorAll('.row-check')[0]?.click();
          document.querySelectorAll('.row-check')[1]?.click();
          document.querySelectorAll('.row-check')[2]?.click();
          break;
        case 'tab-search': {
          const input = document.querySelector('#tabSearch');
          if (input) {
            input.value = 'figma';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          break;
        }
        default:
          break;
      }
    }, 900);
  });
}
