import { IconLockOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      {/* Left panel — branding sidebar */}
      <div className="relative hidden w-1/3 flex-col bg-secondary md:flex lg:w-1/4">
        <div className="absolute top-4 left-4 sm:top-5 sm:left-6">
          <a
            href="https://bittery.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
          </a>
        </div>

        {/* Lock icon — sits on the right edge */}
        <div className="absolute top-1/4 right-0 z-10 translate-x-1/2">
          <div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
            <IconLockOutlineDuo18 className="size-7 text-primary" />
          </div>
        </div>

        {/* Separator line on the right edge */}
        <div className="absolute inset-y-0 right-0 w-px bg-black/10 dark:bg-white/10" />
      </div>

      {/* Right panel — content area */}
      <div className="flex min-h-svh flex-1 flex-col bg-white dark:bg-gray-900">
        {/* Mobile logo */}
        <div className="flex px-5 pt-5 sm:px-8 sm:pt-6 md:hidden">
          <a
            href="https://bittery.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="/logo.png" alt="Bittery" className="h-10 w-auto" />
          </a>
        </div>

        {/* Main content */}
        <main className="flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6">
          <div className="w-full max-w-110 md:-mt-12">
            <Outlet />
          </div>
        </main>

        {/* Footer */}
        <footer>
          <div className="mx-auto flex max-w-105 flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:justify-between">
            <p className="text-muted-foreground/60 text-xs">Bittery</p>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/bittery-org/bittery"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
              >
                GitHub
                <ExternalLink size={10} />
              </a>
              <span className="text-muted-foreground/20">|</span>
              <a
                href="https://github.com/bittery-org/bittery/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
              >
                Help
                <ExternalLink size={10} />
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
