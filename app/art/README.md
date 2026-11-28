# App art sources

Source images for files in `app/public/`. Vite does not serve this folder.

- `goblin-transparent.png`: the full-body goblin on a transparent background.

## App icons

`icon-192.png` and `icon-512.png` are a square head-and-shoulders crop of
the goblin, with no ring. They are the favicon, the home-screen icon and
the install icon. Rebuild them from the repo root:

```sh
for n in 512 192; do
  magick app/art/goblin-transparent.png -crop 1100x1100+110+90 +repage \
    -resize ${n}x${n} -strip app/public/icon-$n.png
done
```

Do not build the icons from `goblin-portrait.webp`. That is the profile
picture: it has a circle crop and a ring.
