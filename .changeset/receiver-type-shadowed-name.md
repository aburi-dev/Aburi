---
"@aburi/lang-typescript": patch
---

Leave a call's `receiverType` out when the type's name means something else where the field is declared than at the module: a type parameter of the class (`class Store<Model> { constructor(private item: Model) {} }`) or of a function or method it is written in, a class expression's own name, or a class, interface, type alias, enum, namespace or import alias that an enclosing block or namespace declares. A reader binds the name at the module, so it would have named an unrelated type of the same name.
