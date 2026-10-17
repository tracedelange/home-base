// Builds dist/ from src/ and content/. Each content item becomes a static page (for search engines, shared links and
// no-JS visitors) and an article in the index that the chart reveals when you land on its moon.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { marked } from 'marked';

const read = f => readFileSync(f, 'utf8');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const date = d => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Frontmatter is plain `key: value` lines between --- fences
function parse(file) {
  const [, head, body] = read(file).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(head.split('\n').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  return { ...meta, body };
}

// ---------- content items: route (planet/name), page file, moon title and description, body ----------
// body(href) renders the item; href(route) links to another item, as a page link or as an in-chart route
const items = [];
const add = (route, file, title, desc, body) => items.push({ route, file, title, desc, body });
const find = route => items.find(i => i.route === route);

// Blog, newest first
const posts = readdirSync('content/blog').filter(f => f.endsWith('.md'))
  .map(f => ({ slug: f.slice(0, -3), ...parse(`content/blog/${f}`) }))
  .sort((a, b) => b.date.localeCompare(a.date));
for (const p of posts) add(`blog/${p.slug}`, `blog/${p.slug}.html`, p.title, p.description, () =>
  `<p class="kicker">Blog · <time datetime="${p.date}">${date(p.date)}</time></p><h1>${esc(p.title)}</h1>${marked.parse(p.body)}`);
add('blog/all', 'blog/index.html', 'All posts', `${posts.length} posts`, href =>
  `<h1>Blog</h1><ul class="list">${posts.map(p =>
    `<li><a href="${href(`blog/${p.slug}`)}"><span>${esc(p.title)}</span><small>${date(p.date)} · ${esc(p.description)}</small></a></li>`).join('')}</ul>`);

// Reading: each ## heading is a board column; each book a list item, "*Title* — Author"
const reading = parse('content/reading.md');
const columns = [];
for (const t of marked.lexer(reading.body)) {
  if (t.type === 'heading' && t.depth === 2) columns.push({ title: t.text, id: t.text.toLowerCase().replace(/\W+/g, '-'), tokens: [] });
  else columns.at(-1)?.tokens.push(t);
}
const books = c => c.tokens.filter(t => t.type === 'list').flatMap(t => t.items).map(i => {
  const [title, author = ''] = i.text.split(' — ');
  return { title: esc(title.replace(/\*/g, '')), author: esc(author) };
});
add('reading/board', 'reading.html', `${reading.year} board`, 'Want to read, reading, read', () =>
  `<h1>Reading in ${reading.year}</h1><div class="board">${columns.map(c =>
    `<section><h2>${esc(c.title)} <small>${books(c).length}</small></h2><ul>${books(c).map(b => `<li><em>${b.title}</em>${b.author}</li>`).join('')}</ul></section>`).join('')}</div>`);

// About
const bio = parse('content/bio.md'), now = parse('content/now.md');
add('about/bio', 'bio.html', 'Bio', 'Who I am, briefly', () => `<h1>Bio</h1>${marked.parse(bio.body)}`);
add('about/now', 'now.html', 'Now', `Updated ${date(now.updated)}`, () =>
  `<h1>Now</h1>${marked.parse(now.body)}<p class="updated">Updated ${date(now.updated)}</p>`);

// ---------- write ----------
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/blog', { recursive: true });
cpSync('src/main.js', 'dist/main.js');
cpSync('src/style.css', 'dist/style.css');

// Static pages; "← System" returns to the item's planet
const template = read('src/page.html');
for (const i of items) {
  const root = '../'.repeat(i.file.split('/').length - 1);
  const body = i.body(r => relative(dirname(i.file), find(r).file));
  writeFileSync(`dist/${i.file}`, template.replaceAll('{{root}}', root).replace('{{planet}}', i.route.split('/')[0])
    .replace('{{title}}', esc(i.title)).replace('{{body}}', body));
}

// Moons link to the static page; main.js reads data-route and lands on the moon instead
const moon = (i, title = esc(i.title), desc = esc(i.desc)) =>
  `<li><a href="${i.file}" data-route="${i.route}"><span>${title}</span><small>${desc}</small></a></li>`;
const current = columns.find(c => c.id === 'reading');
const moons = {
  blog: posts.slice(0, 2).map(p => moon(find(`blog/${p.slug}`))).join('') + moon(find('blog/all')),
  reading: books(current).map(b => moon(find('reading/board'), b.title, b.author)).join('') + moon(find('reading/board')),
  about: moon(find('about/bio')) + moon(find('about/now')),
};
const surfaces = items.map(i => `<article class="surface reading" data-route="${i.route}">${i.body(r => `#${r}`)}</article>`).join('\n');

writeFileSync('dist/index.html', read('src/index.html')
  .replace('<!-- blog -->', moons.blog)
  .replace('<!-- reading -->', moons.reading)
  .replace('<!-- about -->', moons.about)
  .replace('<!-- surfaces -->', surfaces));
console.log(`dist/: index and ${items.length} pages`);
