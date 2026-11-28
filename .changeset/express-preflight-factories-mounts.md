---
"@aburi/framework-express": minor
"@aburi/lang-typescript": minor
---

`options` and `head` are route methods: `app.options("/users/:id", cors())` and `app.head(…)` are
`framework:express:route`, and a chain ending in either (`app.route(p).get(…).options(cors())`) is a
call Symbol again rather than calls on `<module>`. A `use` handed a call (`app.use(cors())`,
`app.use(express.json())`) is `framework:express:middleware` at `medium`, named by that call. A
mount is `high` only when the module binds the name it hands over to a `Router()` /
`express.Router()` of its own; an imported name is a mount at `medium`, and a function the module
declares is middleware.
