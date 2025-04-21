// src/components/Header.js
import React from 'react';

function Header({ 
  currentUser, 
  handleLogout, 
  isComplete, 
  unlabeledRemaining, 
  exportCSV, 
  apiStatus, 
  getTotalDicomCount, 
  setShowCompletionModal 
}) {
  return (
    <header className="app-header">
      {/* Left section - User info */}
      <div className="header-user-section">
        <div className="user-info">
          <span>User: <strong>{currentUser}</strong></span>
          <button className="logout-button" onClick={handleLogout}>Logout</button>
        </div>
      </div>
      
      {/* Middle section - Title */}
      <div className="header-title">
        <h1>Echocardiogram Labeler</h1>
      </div>
      
      {/* Right section - Stats */}
      <div className="header-stats-section">
        {isComplete ? (
          <button className="finish-button" onClick={() => setShowCompletionModal(true)}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Review Complete Labels
          </button>
        ) : (
          <div>
            <button 
              className="download-button" 
              onClick={exportCSV} 
              disabled={apiStatus.loading || getTotalDicomCount() === 0}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Download CSV
            </button>
            <div className="counter">
              <div className="counter-badge">{unlabeledRemaining}</div>
              <span>DICOMs Remaining</span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

export default React.memo(Header);