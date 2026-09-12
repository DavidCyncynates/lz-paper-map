import { ThemeToggle } from '@/components/theme-toggle';

import styles from './papers.module.css';

type CatalogHeaderProps = {
  homeHref: string;
  mapHref: string;
};

export function CatalogHeader({
  homeHref,
  mapHref,
}: CatalogHeaderProps) {
  return (
    <header className={styles.header}>
      <a className={styles.brand} href={mapHref}>
        <strong>LZ Paper Map</strong>
        <span>High-recoil literature</span>
      </a>
      <nav className={styles.headerLinks} aria-label="Paper navigation">
        <a href={mapHref}>Map</a>
        <a href={homeHref}>David Cyncynates</a>
        <ThemeToggle />
      </nav>
    </header>
  );
}
