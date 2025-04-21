import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './LoginScreen.css';

const API_URL = 'http://localhost:8000';

const LoginScreen = ({ onLogin }) => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('select'); // 'select' or 'create'
  const [selectedAccount, setSelectedAccount] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // Fetch accounts on component mount
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/accounts`);
      setAccounts(response.data.accounts || []);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching accounts:', error);
      setError('Failed to load accounts. Please try again.');
      setLoading(false);
    }
  };

  const handleSelectAccount = (event) => {
    setSelectedAccount(event.target.value);
    setError('');
  };

  const handleLogin = async () => {
    if (!selectedAccount) {
      setError('Please select an account');
      return;
    }

    setLoading(true);
    try {
      // Login with selected account
      await axios.post(`${API_URL}/login`, { username: selectedAccount });
      onLogin(selectedAccount);
    } catch (error) {
      console.error('Login error:', error);
      setError('Login failed. Please try again.');
      setLoading(false);
    }
  };

  const handleCreateAccount = async () => {
    if (!newUsername.trim()) {
      setError('Please enter a username');
      return;
    }

    setLoading(true);
    try {
      // Create new account
      await axios.post(`${API_URL}/accounts`, { username: newUsername.trim() });
      
      // Refresh accounts list
      await fetchAccounts();
      
      // Log in with the new account
      onLogin(newUsername.trim());
    } catch (error) {
      console.error('Error creating account:', error);
      
      if (error.response?.status === 409) {
        setError('Username already exists. Please choose another name.');
      } else {
        setError('Failed to create account. Please try again.');
      }
      
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>Echocardiogram Labeler</h1>
        <div className="login-tabs">
          <button 
            className={`tab-button ${mode === 'select' ? 'active' : ''}`} 
            onClick={() => setMode('select')}
          >
            Existing Account
          </button>
          <button 
            className={`tab-button ${mode === 'create' ? 'active' : ''}`} 
            onClick={() => setMode('create')}
          >
            New Account
          </button>
        </div>

        {loading ? (
          <div className="login-loading">
            <div className="loading-spinner"></div>
            <p>Loading...</p>
          </div>
        ) : (
          <div className="login-form">
            {mode === 'select' ? (
              <>
                <div className="form-group">
                  <label>Select Your Account:</label>
                  {accounts.length > 0 ? (
                    <select 
                      value={selectedAccount} 
                      onChange={handleSelectAccount}
                      className="account-select"
                    >
                      <option value="">-- Select an account --</option>
                      {accounts.map((account, index) => (
                        <option key={index} value={account.username}>
                          {account.username}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="no-accounts-message">
                      No accounts found. Please create a new account.
                    </p>
                  )}
                </div>
                {accounts.length > 0 && (
                  <button 
                    className="login-button" 
                    onClick={handleLogin}
                    disabled={!selectedAccount}
                  >
                    Login
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="form-group">
                  <label>Create New Account:</label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="Enter your name"
                    className="username-input"
                  />
                </div>
                <button 
                  className="login-button" 
                  onClick={handleCreateAccount}
                  disabled={!newUsername.trim()}
                >
                  Create Account
                </button>
              </>
            )}

            {error && <p className="error-message">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
};

export default LoginScreen;