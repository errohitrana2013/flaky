// Regenerates src/data/db.js. Deterministic: same seed, same bytes, every run.
// That matters because the file is committed — a nondeterministic generator
// would produce a huge diff on every run and make review impossible.
//
//   npm run seed

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "db.js");

// mulberry32 — small, fast, and identical across Node versions.
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20260829);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(" ");

const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const sentence = (n) => {
  const text = words(n);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const paragraph = (n) => Array.from({ length: n }, () => sentence(between(6, 14))).join(". ") + ".";

const FIRST = ["Leanne", "Ervin", "Clementine", "Patricia", "Chelsey", "Dennis", "Kurtis", "Nicholas", "Glenna", "Clementina"];
const LAST = ["Graham", "Howell", "Bauch", "Lebsack", "Dietrich", "Schulist", "Weissnat", "Runolfsdottir", "Reichert", "DuBuque"];
const CITIES = ["Gwenborough", "Wisokyburgh", "McKenziehaven", "South Elvis", "Roscoeview", "South Christy", "Howemouth", "Aliyaview", "Bartholomebury", "Lebsackbury"];
const COMPANIES = ["Deckow-Crist", "Romaguera-Jacobson", "Keebler LLC", "Considine-Lockman", "Johns Group", "Abernathy Group", "Yost and Sons", "Hoeger LLC", "Schulist Inc", "Braun-Bruen"];

const CATEGORIES = ["laptops", "smartphones", "fragrances", "skincare", "groceries", "home-decoration", "furniture", "tops", "womens-dresses", "mens-shoes"];
const BRANDS = ["Apple", "Samsung", "Huawei", "Infinix", "OPPO", "Chanel", "Dior", "Calvin Klein", "Gucci", "Rolex"];

// --- collections -----------------------------------------------------------

const users = Array.from({ length: 10 }, (_, i) => {
  const first = FIRST[i];
  const last = LAST[i];
  const username = `${first}${last}`.replace(/\s/g, "");
  return {
    id: i + 1,
    name: `${first} ${last}`,
    username,
    email: `${first.toLowerCase()}@${last.toLowerCase()}.example`,
    phone: `1-${between(200, 999)}-${between(200, 999)}-${between(1000, 9999)}`,
    website: `${last.toLowerCase()}.example`,
    address: {
      street: `${sentence(2)} ${pick(["Street", "Avenue", "Lane", "Plaza"])}`,
      suite: `Apt. ${between(100, 999)}`,
      city: CITIES[i],
      zipcode: `${between(10000, 99999)}-${between(1000, 9999)}`,
      geo: { lat: (random() * 180 - 90).toFixed(4), lng: (random() * 360 - 180).toFixed(4) },
    },
    company: { name: COMPANIES[i], catchPhrase: sentence(4), bs: words(3) },
  };
});

const posts = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  userId: between(1, 10),
  title: sentence(between(4, 9)),
  body: paragraph(between(2, 4)),
}));

const comments = Array.from({ length: 500 }, (_, i) => {
  const postId = Math.floor(i / 5) + 1;
  const author = pick(FIRST);
  return {
    id: i + 1,
    postId,
    name: sentence(between(3, 6)),
    email: `${author.toLowerCase()}@${pick(LAST).toLowerCase()}.example`,
    body: paragraph(between(1, 2)),
  };
});

const albums = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  userId: Math.floor(i / 10) + 1,
  title: sentence(between(3, 6)),
}));

const photos = Array.from({ length: 1000 }, (_, i) => {
  const albumId = Math.floor(i / 10) + 1;
  return {
    id: i + 1,
    albumId,
    title: sentence(between(3, 7)),
    url: `https://picsum.photos/seed/${i + 1}/600/600`,
    thumbnailUrl: `https://picsum.photos/seed/${i + 1}/150/150`,
  };
});

const todos = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1,
  userId: Math.floor(i / 20) + 1,
  title: sentence(between(3, 8)),
  completed: random() < 0.4,
}));

// Not in JSONPlaceholder. Included because "build a product list" is the most
// common thing people reach for a mock API to do.
const products = Array.from({ length: 100 }, (_, i) => {
  const price = Number((random() * 1900 + 10).toFixed(2));
  const discount = Number((random() * 20).toFixed(2));
  return {
    id: i + 1,
    title: `${pick(BRANDS)} ${sentence(2)}`,
    description: paragraph(1),
    price,
    discountPercentage: discount,
    rating: Number((random() * 3 + 2).toFixed(2)),
    stock: between(0, 200),
    brand: pick(BRANDS),
    category: pick(CATEGORIES),
    thumbnail: `https://picsum.photos/seed/p${i + 1}/300/300`,
  };
});

const DB = { users, posts, comments, albums, photos, todos, products };

// One collection per line keeps the diff readable when a single record changes.
const body = Object.entries(DB)
  .map(([name, rows]) => `  ${name}: ${JSON.stringify(rows)},`)
  .join("\n");

writeFileSync(
  OUT,
  `// GENERATED by scripts/generate-db.js — do not edit by hand.\n` +
    `// Regenerate with: npm run seed\n\n` +
    `export default {\n${body}\n};\n`
);

const counts = Object.entries(DB).map(([k, v]) => `${k} ${v.length}`).join(", ");
console.log(`wrote ${OUT}`);
console.log(counts);
