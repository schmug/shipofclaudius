# {{TITLE}}

{{SUMMARY}}

Built by the software factory (`shipofclaudius` `factory-intake`). Spec: `{{SPEC_PATH}}`.

```sh
npm ci
npm test            # node --test
npm run dev         # wrangler dev
npm run deploy      # production: wrangler.jsonc → {{SLUG}}.{{PROD_DOMAIN}}
```

Preview candidates deploy with `npx wrangler deploy --config wrangler.preview.<key>.jsonc` to `{{SLUG}}-<key>.{{PREVIEW_DOMAIN}}`.
