import { SetupWizard } from '@/components/setup-wizard';

export default function SetupPage() {
  return (
    <main className="tauri-android-content-safe-bottom h-screen h-[100dvh] w-full overflow-y-auto overscroll-contain bg-muted/30 p-4 pb-8 pt-4 sm:p-8 md:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <SetupWizard />
      </div>
    </main>
  );
}
