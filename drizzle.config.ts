export default {
  schema: "./app/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "sqlite.db",
  },
};
