# bittery

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Start, Hono, TRPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Start** - SSR framework with TanStack Router
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **shadcn/ui** - Reusable UI components
- **Hono** - Lightweight, performant server framework
- **tRPC** - End-to-end type-safe APIs
- **Bun** - Runtime environment
- **Drizzle** - TypeScript-first ORM
- **PostgreSQL** - Database engine
- **Authentication** - Better-Auth
- **Biome** - Linting and formatting
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
pnpm install
```
## Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up.
2. Update your `apps/server/.env` file with your PostgreSQL connection details.

3. Apply the schema to your database:
```bash
pnpm run db:migrate
```


Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).







## Project Structure

```
bittery/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Start)
│   └── server/      # Backend API (Hono, TRPC)
├── packages/
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run dev:server`: Start only the server
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:migrate`: Apply migrations to database
- `pnpm run db:studio`: Open database studio UI
- `pnpm run check`: Run Biome formatting and linting



Continue Phase 5 (Migration & Cleanup) from packages/bittery-crypto/PLAN.md.                                                        
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  All platforms now use native Rust crypto:                                                                                           
                                                                                                                                      
  - Web app: WASM (Phase 2.1) ✅                                                                                                      
                                                                                                                                      
  - Server: NAPI bindings (Phase 2.2) ✅                                                                                              
                                                                                                                                      
  - Mobile: Nitro module (Phase 3) ✅                                                                                                 
                                                                                                                                      
  - Credential Provider: JNI (Phase 3.7) ✅                                                                                           
                                                                                                                                      
  - Desktop: Tauri commands (Phase 4.1) ✅                                                                                            
                                                                                                                                      
  - Browser Extension: WASM (Phase 4.2) ✅                                                                                            
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  Cleanup tasks:                                                                                                                      
                                                                                                                                      
  1. Remove pure JS crypto implementations from packages/crypto/                                                                      
                                                                                                                                      
  - Keep TypeScript types/interfaces (EncryptedData, DerivedKeys, etc.)                                                               
                                                                                                                                      
  - Remove key-derivation.ts implementation (keep types)                                                                              
                                                                                                                                      
  - Remove encryption.ts implementation (keep types)                                                                                  
                                                                                                                                      
  - Remove srp-client.ts implementation (keep types)                                                                                  
                                                                                                                                      
  - Remove rsa.ts implementation (keep types)                                                                                         
                                                                                                                                      
  - Keep storage-chrome.ts and server-url.ts (Chrome-specific utilities)                                                              
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  2. Remove deprecated dependencies from apps/mobile/package.json:                                                                    
                                                                                                                                      
  - react-native-quick-crypto                                                                                                         
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  3. Remove apps/mobile/modules/srp6a/ Expo module entirely                                                                           
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  4. Update any remaining imports that still use the old implementations                                                              
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  5. Run pnpm install to update lockfile after dependency changes                                                                     
                                                                                                                                      
                                                                                                                                      
                                                                                                                                      
  Reference: packages/bittery-crypto/PLAN.md 