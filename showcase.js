const showcaseFilters = document.querySelectorAll('[data-filter]');
const cards = document.querySelectorAll('.item-card');
showcaseFilters.forEach((button) => button.addEventListener('click', () => {
  showcaseFilters.forEach((item) => item.classList.remove('active-filter'));
  button.classList.add('active-filter');
  const selected = button.dataset.filter;
  cards.forEach((card) => { card.hidden = selected !== 'all' && card.dataset.category !== selected; });
}));

const tableFilters = document.querySelectorAll('[data-table-filter]');
const rows = document.querySelectorAll('tbody tr');
const search = document.querySelector('#search');
const count = document.querySelector('#visible-count');
function updateTable() {
  const selected = document.querySelector('.table-filters .active-filter')?.dataset.tableFilter || 'all';
  const query = search?.value.trim().toLowerCase() || '';
  let visible = 0;
  rows.forEach((row) => {
    const matchesCategory = selected === 'all' || row.dataset.tableCategory === selected;
    const matchesQuery = !query || row.textContent.toLowerCase().includes(query);
    row.hidden = !(matchesCategory && matchesQuery);
    if (!row.hidden) visible += 1;
  });
  if (count) count.textContent = String(visible).padStart(2, '0');
}
tableFilters.forEach((button) => button.addEventListener('click', () => {
  tableFilters.forEach((item) => item.classList.remove('active-filter'));
  button.classList.add('active-filter');
  updateTable();
}));
search?.addEventListener('input', updateTable);
