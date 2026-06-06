import './globals.css';

export const metadata = {
  title: 'TFT Time Dashboard',
  description: 'Track TFT time, placements, and progress over time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
