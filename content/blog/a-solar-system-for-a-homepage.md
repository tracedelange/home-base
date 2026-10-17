---
title: A solar system for a homepage
date: 2026-10-16
description: Why this site is a chart and not a list
---
Stub post. Most personal sites are a list of links. This one is a top-down chart: each section is a planet, and its links are moons.

## How it's built

- An SVG chart for the orbits and bodies
- A WebGL layer for the 30,000-dot belt
- Markdown files, built into plain HTML pages like this one

> The chart reads the site's own navigation list, so without JavaScript you still get the links.

Code looks like this:

```js
const speed = K / r ** 1.5; // Kepler: outer bodies drift slower
```
