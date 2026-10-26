const header = document.querySelector('.header');

function updateHeaderAppearance() {
  header?.classList.toggle('is-scrolled', window.scrollY > 12);
}

updateHeaderAppearance();
window.addEventListener('scroll', updateHeaderAppearance, { passive: true });
window.addEventListener('pageshow', updateHeaderAppearance);
