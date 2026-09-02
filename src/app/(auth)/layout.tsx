import { HandyPosLogo } from '@/components/icons/logo';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="tauri-android-safe-bottom h-screen h-[100dvh] w-full overflow-y-auto bg-muted/40">
      <div className="tauri-android-content-safe-bottom mx-auto flex min-h-full w-full flex-col items-center px-4 py-6 sm:py-8">
        <div className="my-auto flex w-full flex-col items-center">
          <div className="mb-6 flex items-center gap-3 text-center sm:mb-8">
            <HandyPosLogo className="h-10 w-10" />
            <h1 className="text-2xl font-semibold tracking-normal">Handy POS</h1>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
