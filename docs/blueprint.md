# **App Name**: Handy-POS

## Core Features:

- Offline-First Architecture: Utilize IndexedDB with Dexie.js for local data persistence and background synchronization to ensure functionality even without internet connectivity.
- Smart Setup Wizard: Guide users through an intuitive onboarding process, allowing them to select their business type, system mode (offline-only or online sync), multi-branch support, tax system, currency, receipt format, and POS mode, automatically configuring default features based on their selections.
- Multi-Business and Branch Management: Enable users to manage multiple businesses and branches within a single account, with separate inventories, POS sessions, and financial reports, and the ability to switch between businesses seamlessly.
- Progressive Web App (PWA) Features: Implement PWA capabilities to allow users to install the application on desktop and mobile devices, with background sync and offline caching for a native app-like experience.
- Secure Server Actions: Utilize Next.js Server Actions for secure database operations.
- Edge-Ready API Routes: Implement API routes optimized for edge deployment.
- Automated Feature Optimization: The smart setup tool uses generative AI to customize the application based on the user's configurations, such as POS mode (Fast Checkout, Restaurant Orders, Liquor/Bottle mode). This tool will use reasoning to suggest appropriate optimized features per business type to improve user experience.

## Style Guidelines:

- Primary color: Deep purple (#673AB7), conveys professionalism and trust, suitable for enterprise environments.
- Background color: Very light purple (#F3E5F5), almost white, provides a clean and modern aesthetic.
- Accent color: Blue-purple (#3F51B5), offers a high-contrast highlight that is analogous with the primary.
- Font pairing: 'Space Grotesk' (sans-serif) for headlines and short descriptions; 'Inter' (sans-serif) for body text and detailed information. Note: currently only Google Fonts are supported.
- Code font: 'Source Code Pro' for displaying code snippets. Note: currently only Google Fonts are supported.
- Use a consistent set of vector icons to represent common actions and business types. Icons should be simple, modern, and easily recognizable.
- Design a responsive layout optimized for both desktop and mobile devices. Prioritize key information and actions, ensuring they are easily accessible on smaller screens.
- Incorporate subtle animations and transitions to provide visual feedback and enhance the user experience. Keep animations performant to avoid impacting performance on low-end devices.