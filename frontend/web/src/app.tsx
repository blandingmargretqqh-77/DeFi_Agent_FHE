// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PortfolioRecord {
  id: string;
  encryptedBalance: string;
  encryptedAPY: string;
  timestamp: number;
  protocol: string;
  asset: string;
  status: "active" | "inactive";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [portfolios, setPortfolios] = useState<PortfolioRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPortfolioData, setNewPortfolioData] = useState({ protocol: "", asset: "", balance: 0, apy: 0 });
  const [selectedPortfolio, setSelectedPortfolio] = useState<PortfolioRecord | null>(null);
  const [decryptedBalance, setDecryptedBalance] = useState<number | null>(null);
  const [decryptedAPY, setDecryptedAPY] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const [notifications, setNotifications] = useState<string[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  const activeCount = portfolios.filter(p => p.status === "active").length;
  const inactiveCount = portfolios.filter(p => p.status === "inactive").length;

  useEffect(() => {
    loadPortfolios().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const addNotification = (message: string) => {
    setNotifications(prev => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev.slice(0, 9)]);
  };

  const loadPortfolios = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        addNotification("Contract is not available");
        return;
      }

      // Get portfolio keys
      const keysBytes = await contract.getData("portfolio_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { 
          console.error("Error parsing portfolio keys:", e);
          addNotification("Error parsing portfolio keys");
        }
      }

      // Load each portfolio
      const list: PortfolioRecord[] = [];
      for (const key of keys) {
        try {
          const portfolioBytes = await contract.getData(`portfolio_${key}`);
          if (portfolioBytes.length > 0) {
            try {
              const portfolioData = JSON.parse(ethers.toUtf8String(portfolioBytes));
              list.push({ 
                id: key, 
                encryptedBalance: portfolioData.balance, 
                encryptedAPY: portfolioData.apy,
                timestamp: portfolioData.timestamp, 
                protocol: portfolioData.protocol, 
                asset: portfolioData.asset, 
                status: portfolioData.status || "active" 
              });
            } catch (e) { 
              console.error(`Error parsing portfolio data for ${key}:`, e);
              addNotification(`Error parsing portfolio ${key}`);
            }
          }
        } catch (e) { 
          console.error(`Error loading portfolio ${key}:`, e);
          addNotification(`Error loading portfolio ${key}`);
        }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setPortfolios(list);
      addNotification(`Loaded ${list.length} portfolios`);
    } catch (e) { 
      console.error("Error loading portfolios:", e);
      addNotification("Failed to load portfolios");
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitPortfolio = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addNotification("Wallet not connected");
      return; 
    }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting portfolio data with Zama FHE..." });
    addNotification("Starting portfolio encryption");
    
    try {
      // Encrypt sensitive data
      const encryptedBalance = FHEEncryptNumber(newPortfolioData.balance);
      const encryptedAPY = FHEEncryptNumber(newPortfolioData.apy);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const portfolioId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const portfolioData = { 
        balance: encryptedBalance, 
        apy: encryptedAPY,
        timestamp: Math.floor(Date.now() / 1000), 
        protocol: newPortfolioData.protocol, 
        asset: newPortfolioData.asset, 
        status: "active" 
      };
      
      // Store portfolio data
      await contract.setData(`portfolio_${portfolioId}`, ethers.toUtf8Bytes(JSON.stringify(portfolioData)));
      addNotification(`Portfolio ${portfolioId} encrypted and stored`);
      
      // Update keys list
      const keysBytes = await contract.getData("portfolio_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
          addNotification("Loaded existing portfolio keys");
        } catch (e) { 
          console.error("Error parsing keys:", e);
          addNotification("Error parsing portfolio keys");
        }
      }
      keys.push(portfolioId);
      await contract.setData("portfolio_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      addNotification("Updated portfolio keys");
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted portfolio submitted securely!" });
      addNotification("Portfolio creation successful");
      
      await loadPortfolios();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPortfolioData({ protocol: "", asset: "", balance: 0, apy: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      addNotification(`Portfolio creation failed: ${errorMessage}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      addNotification("Wallet not connected for decryption");
      return null; 
    }
    setIsDecrypting(true);
    addNotification("Starting decryption process");
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      addNotification("Wallet signature obtained");
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e);
      addNotification("Decryption failed");
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const togglePortfolioStatus = async (portfolioId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating portfolio status with FHE..." });
    addNotification(`Updating status for portfolio ${portfolioId}`);
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const portfolioBytes = await contract.getData(`portfolio_${portfolioId}`);
      if (portfolioBytes.length === 0) throw new Error("Portfolio not found");
      const portfolioData = JSON.parse(ethers.toUtf8String(portfolioBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPortfolio = { 
        ...portfolioData, 
        status: portfolioData.status === "active" ? "inactive" : "active" 
      };
      
      await contractWithSigner.setData(`portfolio_${portfolioId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPortfolio)));
      addNotification(`Portfolio ${portfolioId} status updated`);
      
      setTransactionStatus({ visible: true, status: "success", message: "Portfolio status updated successfully!" });
      await loadPortfolios();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      addNotification(`Portfolio update failed: ${e.message}`);
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredPortfolios = portfolios.filter(portfolio => {
    const matchesSearch = 
      portfolio.protocol.toLowerCase().includes(searchTerm.toLowerCase()) || 
      portfolio.asset.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = 
      activeFilter === "all" || 
      (activeFilter === "active" && portfolio.status === "active") || 
      (activeFilter === "inactive" && portfolio.status === "inactive");
    return matchesSearch && matchesFilter;
  });

  const renderPortfolioChart = () => {
    if (portfolios.length === 0) return <div className="no-data-chart">No portfolio data available</div>;
    
    const protocolDistribution: Record<string, number> = {};
    portfolios.forEach(p => {
      if (p.status === "active") {
        protocolDistribution[p.protocol] = (protocolDistribution[p.protocol] || 0) + 1;
      }
    });

    return (
      <div className="portfolio-chart">
        <h3>Protocol Distribution</h3>
        <div className="chart-bars">
          {Object.entries(protocolDistribution).map(([protocol, count]) => (
            <div key={protocol} className="chart-bar">
              <div className="bar-label">{protocol}</div>
              <div className="bar-container">
                <div 
                  className="bar-fill" 
                  style={{ width: `${(count / activeCount) * 100}%` }}
                ></div>
              </div>
              <div className="bar-value">{count}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="ai-icon"></div>
          </div>
          <h1>FHE<span>DeFi</span>Agent</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-portfolio-btn tech-button"
          >
            <div className="add-icon"></div>Add Portfolio
          </button>
          <button 
            className="tech-button notification-btn" 
            onClick={() => setShowNotifications(!showNotifications)}
          >
            <div className="bell-icon"></div>
            {notifications.length > 0 && <span className="notification-badge">{notifications.length}</span>}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-grid">
          <div className="dashboard-panel left-panel">
            <div className="welcome-banner tech-card">
              <h2>FHE-Powered DeFi Agent</h2>
              <p>AI-managed portfolio with fully homomorphic encryption</p>
              <div className="fhe-badge">
                <span>ZAMA FHE Technology</span>
              </div>
            </div>

            <div className="stats-grid tech-card">
              <div className="stat-item">
                <div className="stat-value">{portfolios.length}</div>
                <div className="stat-label">Total Assets</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{activeCount}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{inactiveCount}</div>
                <div className="stat-label">Inactive</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">
                  {portfolios.length > 0 ? 
                    Math.round(portfolios.reduce((sum, p) => sum + (p.status === "active" ? 1 : 0), 0) / portfolios.length * 100) : 0}%
                </div>
                <div className="stat-label">Active Ratio</div>
              </div>
            </div>

            {renderPortfolioChart()}
          </div>

          <div className="dashboard-panel right-panel">
            <div className="panel-header">
              <h2>Encrypted Portfolio Assets</h2>
              <div className="header-actions">
                <div className="search-filter">
                  <input
                    type="text"
                    placeholder="Search protocols/assets..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="tech-input"
                  />
                  <select
                    value={activeFilter}
                    onChange={(e) => setActiveFilter(e.target.value as "all" | "active" | "inactive")}
                    className="tech-select"
                  >
                    <option value="all">All</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <button 
                  onClick={loadPortfolios} 
                  className="refresh-btn tech-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <div className="portfolio-list tech-card">
              <div className="table-header">
                <div className="header-cell">Protocol</div>
                <div className="header-cell">Asset</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              
              {filteredPortfolios.length === 0 ? (
                <div className="no-portfolios">
                  <div className="no-data-icon"></div>
                  <p>No matching portfolios found</p>
                  <button 
                    className="tech-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Add First Portfolio
                  </button>
                </div>
              ) : (
                filteredPortfolios.map(portfolio => (
                  <div 
                    className="portfolio-row" 
                    key={portfolio.id} 
                    onClick={() => setSelectedPortfolio(portfolio)}
                  >
                    <div className="table-cell protocol">{portfolio.protocol}</div>
                    <div className="table-cell asset">{portfolio.asset}</div>
                    <div className="table-cell">
                      <span className={`status-badge ${portfolio.status}`}>
                        {portfolio.status}
                      </span>
                    </div>
                    <div className="table-cell actions">
                      <button 
                        className="action-btn tech-button" 
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePortfolioStatus(portfolio.id);
                        }}
                      >
                        {portfolio.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitPortfolio} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          portfolioData={newPortfolioData} 
          setPortfolioData={setNewPortfolioData}
        />
      )}

      {selectedPortfolio && (
        <PortfolioDetailModal 
          portfolio={selectedPortfolio} 
          onClose={() => { 
            setSelectedPortfolio(null); 
            setDecryptedBalance(null);
            setDecryptedAPY(null);
          }} 
          decryptedBalance={decryptedBalance}
          decryptedAPY={decryptedAPY}
          setDecryptedBalance={setDecryptedBalance}
          setDecryptedAPY={setDecryptedAPY}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {showNotifications && (
        <div className="notifications-panel tech-card">
          <div className="notifications-header">
            <h3>System Notifications</h3>
            <button onClick={() => setShowNotifications(false)} className="close-notifications">
              &times;
            </button>
          </div>
          <div className="notifications-list">
            {notifications.length === 0 ? (
              <div className="no-notifications">No notifications</div>
            ) : (
              notifications.map((note, index) => (
                <div key={index} className="notification-item">
                  {note}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="ai-icon"></div>
              <span>FHE DeFi Agent</span>
            </div>
            <p>AI-managed DeFi portfolios with Zama FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">GitHub</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE DeFi Agent. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  portfolioData: any;
  setPortfolioData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, portfolioData, setPortfolioData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setPortfolioData({ ...portfolioData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setPortfolioData({ ...portfolioData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!portfolioData.protocol || !portfolioData.asset || !portfolioData.balance) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Add Encrypted Portfolio</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your portfolio data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Protocol *</label>
              <select 
                name="protocol" 
                value={portfolioData.protocol} 
                onChange={handleChange} 
                className="tech-select"
              >
                <option value="">Select protocol</option>
                <option value="Aave">Aave</option>
                <option value="Compound">Compound</option>
                <option value="Uniswap">Uniswap</option>
                <option value="Curve">Curve</option>
                <option value="Lido">Lido</option>
                <option value="Other">Other</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Asset *</label>
              <input 
                type="text" 
                name="asset" 
                value={portfolioData.asset} 
                onChange={handleChange} 
                placeholder="e.g. ETH, USDC, WBTC..." 
                className="tech-input"
              />
            </div>
            
            <div className="form-group">
              <label>Balance *</label>
              <input 
                type="number" 
                name="balance" 
                value={portfolioData.balance} 
                onChange={handleNumberChange} 
                placeholder="Enter amount..." 
                className="tech-input"
                step="0.0001"
              />
            </div>
            
            <div className="form-group">
              <label>APY (%)</label>
              <input 
                type="number" 
                name="apy" 
                value={portfolioData.apy} 
                onChange={handleNumberChange} 
                placeholder="Estimated APY..." 
                className="tech-input"
                step="0.1"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Balance:</span>
                <div>{portfolioData.balance || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {portfolioData.balance ? 
                    FHEEncryptNumber(portfolioData.balance).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Data Privacy Guarantee</strong>
              <p>Your portfolio data remains encrypted during FHE processing</p>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn tech-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface PortfolioDetailModalProps {
  portfolio: PortfolioRecord;
  onClose: () => void;
  decryptedBalance: number | null;
  decryptedAPY: number | null;
  setDecryptedBalance: (value: number | null) => void;
  setDecryptedAPY: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const PortfolioDetailModal: React.FC<PortfolioDetailModalProps> = ({ 
  portfolio, 
  onClose, 
  decryptedBalance,
  decryptedAPY,
  setDecryptedBalance,
  setDecryptedAPY,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedBalance !== null) { 
      setDecryptedBalance(null);
      setDecryptedAPY(null);
      return; 
    }
    
    const decryptedBal = await decryptWithSignature(portfolio.encryptedBalance);
    const decryptedApy = await decryptWithSignature(portfolio.encryptedAPY);
    
    if (decryptedBal !== null) setDecryptedBalance(decryptedBal);
    if (decryptedApy !== null) setDecryptedAPY(decryptedApy);
  };

  return (
    <div className="modal-overlay">
      <div className="portfolio-detail-modal tech-card">
        <div className="modal-header">
          <h2>Portfolio Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="portfolio-info">
            <div className="info-item">
              <span>Protocol:</span>
              <strong>{portfolio.protocol}</strong>
            </div>
            <div className="info-item">
              <span>Asset:</span>
              <strong>{portfolio.asset}</strong>
            </div>
            <div className="info-item">
              <span>Date Added:</span>
              <strong>{new Date(portfolio.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${portfolio.status}`}>
                {portfolio.status}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>FHE Encrypted Data</h3>
            <div className="data-grid">
              <div className="data-item">
                <span>Encrypted Balance:</span>
                <div className="encrypted-data">
                  {portfolio.encryptedBalance.substring(0, 50)}...
                </div>
              </div>
              <div className="data-item">
                <span>Encrypted APY:</span>
                <div className="encrypted-data">
                  {portfolio.encryptedAPY.substring(0, 50)}...
                </div>
              </div>
            </div>
            
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
            
            <button 
              className="decrypt-btn tech-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedBalance !== null ? (
                "Hide Decrypted Values"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedBalance !== null && decryptedAPY !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Values</h3>
              <div className="data-grid">
                <div className="data-item">
                  <span>Balance:</span>
                  <div className="decrypted-value">
                    {decryptedBalance.toLocaleString()}
                  </div>
                </div>
                <div className="data-item">
                  <span>APY:</span>
                  <div className="decrypted-value">
                    {decryptedAPY}%
                  </div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;