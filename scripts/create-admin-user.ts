import { auth } from "../app/lib/auth";

async function main() {
  const email = "info@canvasstudios.store";
  const password = "Canvas2026!";
  const name = "Canvas Admin";
  
  console.log(`Creating/Updating account for ${email}...`);
  
  try {
     const res = await auth.api.signUpEmail({
        body: {
            email,
            password,
            name
        }
     });
     console.log("Account created successfully:", res.user.email);
     
     // Set role to admin if possible
     await auth.api.updateUser({
         body: {
             role: "admin"
         },
         headers: new Headers({
             // We might need a session to update, but better-auth signUp might already return one or we can bypass for local script
         })
     });
  } catch (e: any) {
      if (e.body?.code === "USER_ALREADY_EXISTS" || e.message?.includes("exists")) {
          console.log("Account already exists. To change the password, you might need to delete the user from sqlite.db first or use changePassword API.");
      } else {
          console.error("Error:", e);
      }
  }
}

main().catch(console.error);