// Which methods each shape of resource path accepts.
//
//   collection   /v1/posts              list, or create
//   record       /v1/posts/1            read, replace, merge, remove
//   nested       /v1/posts/1/comments   list the children, or create one under its parent
//
// Read by the handlers that enforce it and by /v1/meta and the OpenAPI spec that
// describe it, so the landing page cannot offer a method the API refuses. The
// sandbox accepts exactly the same, so moving from echoed writes to stored ones
// stays a URL change and nothing else.
export const METHODS = {
  collection: ["GET", "POST"],
  record: ["GET", "PUT", "PATCH", "DELETE"],
  nested: ["GET", "POST"],
};
