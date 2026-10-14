import React from 'react';
import { Link } from 'wouter';

export function NotFoundPage() {
  return (
    <div className="empty-state">
      <div className="empty-state-title">Page not found</div>
      <div className="empty-state-text">That route does not exist in Gnito.</div>
      <Link href="/" className="btn btn-primary">Back to chat</Link>
    </div>
  );
}
