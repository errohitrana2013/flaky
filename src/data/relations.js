// Which nested routes exist, and the foreign key each one joins on.
//
//   RELATIONS[parent][child] = field on the child pointing back at the parent
//
// GET /v1/posts/1/comments  →  comments where postId === 1
//
// Adding a nested route is one line here. resources.js reads this and needs no
// change, and the 404 hint for a bad nested path is generated from it.

export const RELATIONS = {
  posts: { comments: "postId" },
  albums: { photos: "albumId" },
  users: { posts: "userId", albums: "userId", todos: "userId" },
};

export const childrenOf = (parent) => Object.keys(RELATIONS[parent] || {});
