import { db } from "../app/lib/db";
import { user, account } from "../app/lib/db/schema";
import { auth } from "../app/lib/auth";
import { hash } from "bcryptjs"; // Better auth hashes internally but we might need to manually insert if we can't use api

// Actually better-auth has a programmatic API
// But running it in a standalone script might be tricky without full next context
// Let's try to use the auth api if possible, or just insert into DB directly for bootstrap

async function main() {
  const email = "admin.com";
  const password = "admin123456";
  const name = "Admin";
  
  // Using internal better-auth logic is best, but for a script, direct DB access is easier if we know the hashing
  // Better Auth uses its own hashing. 
  
  // Let's try to use the auth instance directly. 
  // Note: better-auth `api` usually expects a request context.
  
  console.log("Creating admin user...");
  
  try {
     const res = await auth.api.signUpEmail({
        body: {
            email,
            password,
            name
        }
     });
     console.log("User created:", res);
  } catch (e) {
      console.log("Error creating user (might already exist):", e);
  }
}

main().catch(console.error);
