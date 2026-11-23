---
"@aburi/framework-next": patch
---

Read `app/**/route.tsx` and `route.jsx` as route handlers, as Next.js does. An Open Graph image
handler renders JSX into an `ImageResponse`, so it is written as `app/api/og/route.tsx`; its `GET`
was left to framework-react, which filed it as a component.
