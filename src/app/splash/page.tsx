import styles from './splash.module.css';
import { AppVersionLabel } from '@/components/app-version-label';

export default function SplashPage() {
  return (
    <main className={styles.root} aria-label="Loading application">
      <div className={styles.card}>
        <img
          src="/app-icon.png"
          alt="Handy POS Logo"
          className={styles.logo}
          draggable={false}
        />
        <h1 className={styles.title}>Handy POS</h1>
        <p className={styles.subtitle}>Point of Sale System</p>
        <div className={styles.spinner} />
        <p className={styles.status}>Loading...</p>
        <AppVersionLabel variant="plain" tone="splash" className={styles.version} />
      </div>
    </main>
  );
}
