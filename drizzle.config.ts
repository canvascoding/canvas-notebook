const config = {
  schema: "./app/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://canvas:build-placeholder@localhost:5432/canvas_notebook",
  },
};

export default config;
