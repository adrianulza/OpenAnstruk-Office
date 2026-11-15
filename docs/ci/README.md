# CI files to install by hand

The token used for automated pushes cannot change `.github/workflows/` (it lacks the GitHub `workflow` scope), so these two files are parked here. Copy them once from your PC:

```
copy docs\ci\test.yml  .github\workflows\test.yml
copy docs\ci\pages.yml .github\workflows\pages.yml
git add .github/workflows && git commit -m "CI: tests + safer Pages previews" && git push
```

- `test.yml`: runs `npm test` and `npm run check` on every push.
- `pages.yml`: the current Pages workflow, plus HTML-escaped branch names and commit messages in the preview list, and `test/` and `runs/` left out of the published site.
