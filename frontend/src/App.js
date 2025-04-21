import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Slider from '@mui/material/Slider';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ReplayIcon from '@mui/icons-material/Replay';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import LoginScreen from './components/LoginScreen'; // Import the new LoginScreen component
import './App.css';

const API_URL = 'http://localhost:8000';

class DicomQueueManager {
  constructor(apiResponse) {
    this.unlabeledQueue = [];
    this.allDicomsMap = new Map();
    this.processApiResponse(apiResponse);
  }

  processApiResponse(apiResponse) {
    for (const patient of apiResponse.patients) {
      const patientName = patient.patientName;
      const patientDicomsMap = new Map();
      
      for (const dicom of patient.dicoms) {
        // Store DICOM metadata (without images) to save memory
        const dicomMeta = { ...dicom };
        delete dicomMeta.images; // Remove any images to keep memory usage low
        
        patientDicomsMap.set(dicom.dicomName, dicomMeta);
        
        if (dicom.label === 0) {
          this.unlabeledQueue.push({ patientName, dicom: dicomMeta });
        }
      }
      
      this.allDicomsMap.set(patientName, patientDicomsMap);
    }
  }

  prioritizePatient(patientName) {
    const patientDicomsMap = this.allDicomsMap.get(patientName);
    if (!patientDicomsMap) return null;
    
    // Get all unlabeled DICOMs for this patient
    const patientUnlabeledDicoms = this.unlabeledQueue.filter(
      item => item.patientName === patientName
    );
    
    if (patientUnlabeledDicoms.length > 0) {
      // Remove these DICOMs from their current position in queue
      this.unlabeledQueue = this.unlabeledQueue.filter(
        item => item.patientName !== patientName
      );
      
      // Add them to the front of the queue
      this.unlabeledQueue.unshift(...patientUnlabeledDicoms);
      
      // Return the first item
      return patientUnlabeledDicoms[0];
    } else {
      // If there are no unlabeled DICOMs for this patient,
      // just return the first DICOM of the patient (labeled or not)
      const patientDicoms = Array.from(patientDicomsMap.values());
      if (patientDicoms.length === 0) return null;
      
      const firstDicom = patientDicoms[0];
      return { patientName, dicom: firstDicom };
    }
  }
  
  prioritizeSpecificDicom(patientName, dicomName) {
    const dicom = this.getDicom(patientName, dicomName);
    if (!dicom) return null;
    
    const queueItem = { patientName, dicom };
    
    const queueIndex = this.unlabeledQueue.findIndex(
      item => item.patientName === patientName && item.dicom.dicomName === dicomName
    );
    
    if (queueIndex !== -1) {
      if (queueIndex > 0) {
        // Remove and place at front of queue
        this.unlabeledQueue.splice(queueIndex, 1);
        this.unlabeledQueue.unshift(queueItem);
      }
      // If already at front (index 0), do nothing
    } else {
      // Not in queue, so add to front
      this.unlabeledQueue.unshift(queueItem);
    }
    
    return queueItem;
  }

  getNext() {
    return this.unlabeledQueue.length > 0 ? this.unlabeledQueue[0] : null;
  }

  dequeue() {
    return this.unlabeledQueue.length > 0 ? this.unlabeledQueue.shift() : null;
  }

  updateDicomLabel(patientName, dicomName, newLabel) {
    const patientDicomsMap = this.allDicomsMap.get(patientName);
    if (!patientDicomsMap) return false;
    
    const dicom = patientDicomsMap.get(dicomName);
    if (!dicom) return false;
    
    dicom.label = newLabel;
    
    const queueIndex = this.unlabeledQueue.findIndex(
      item => item.patientName === patientName && item.dicom.dicomName === dicomName
    );
    
    if (queueIndex !== -1) {
      if (newLabel !== 0) {
        this.unlabeledQueue.splice(queueIndex, 1);
      } else {
        this.unlabeledQueue[queueIndex].dicom.label = newLabel;
      }
    }
    
    return true;
  }

  handlePostLabeling(patientName, dicomName, wasAlreadyLabeled) {
    if (wasAlreadyLabeled) return this.getNext();
    
    const currentIndex = this.unlabeledQueue.findIndex(
      item => item.patientName === patientName && item.dicom.dicomName === dicomName
    );
    
    if (currentIndex !== -1) {
      this.unlabeledQueue.splice(currentIndex, 1);
    }
    
    return this.getNext();
  }

  getDicom(patientName, dicomName) {
    return this.allDicomsMap.get(patientName)?.get(dicomName);
  }

  getPatientDicoms(patientName) {
    const patientDicomsMap = this.allDicomsMap.get(patientName);
    return patientDicomsMap ? Array.from(patientDicomsMap.values()) : [];
  }

  getAllPatients() {
    return Array.from(this.allDicomsMap.keys());
  }

  getUnlabeledCount() {
    return this.unlabeledQueue.length;
  }
  
  getTotalUnlabeledCountForPatient(patientName) {
    return this.unlabeledQueue.filter(item => item.patientName === patientName).length;
  }
}

const muiTheme = createTheme({
  palette: { primary: { main: '#1976d2' } },
  components: {
    MuiSlider: {
      styleOverrides: {
        root: { height: 8, padding: '15px 0' },
        thumb: {
          height: 24, width: 24, backgroundColor: '#fff', border: '2px solid #1976d2',
          '&:focus, &:hover, &.Mui-active': { boxShadow: '0 0 0 8px rgba(25, 118, 210, 0.16)' }
        },
        track: { height: 8, borderRadius: 4 },
        rail: { height: 8, borderRadius: 4, backgroundColor: '#e0e0e0' }
      }
    }
  }
});

// Custom Dropdown Component
const CustomDropdown = ({ options, value, onChange, disabled, label, isLabeledFn, loading, showCheckInSelected = true }) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  // Key change: Calculate these values inside the render function
  // This ensures they're always based on the latest data
  const selectedOption = options[value];
  
  // Calculate isLabeled status with latest data
  const selectedIsLabeled = selectedOption && isLabeledFn ? isLabeledFn(selectedOption) : false;
  
  return (
    <div className="custom-dropdown" ref={dropdownRef}>
      <label>{label}:</label>
      <div 
        className={`selected-option ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
      >
        <div className="selected-content">
          <span>{selectedOption?.name || 'Select'}</span>
          {showCheckInSelected && <span className="checkmark" style={{ visibility: selectedIsLabeled ? 'visible' : 'hidden' }}>✓</span>}
          {loading && <span className="loading-spinner-small"></span>}
        </div>
        <span className="dropdown-arrow">▼</span>
      </div>
      
      {isOpen && (
        <div className="dropdown-options">
          {options.map((option, index) => {
            // Calculate isLabeled status for each option with latest data
            const isLabeled = isLabeledFn ? isLabeledFn(option) : false;
            
            return (
              <div 
                key={index} 
                className={`dropdown-option ${value === index ? 'selected' : ''}`}
                onClick={() => { 
                  onChange({ target: { value: index } }); 
                  setIsOpen(false); 
                }}
              >
                <span>{option.name}</span>
                <span className="checkmark" style={{ visibility: isLabeled ? 'visible' : 'hidden' }}>✓</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const DicomSlider = ({ dicom, currentImageIndex, setCurrentImageIndex, buttonsDisabled }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const playIntervalRef = useRef(null);
  const lastTimeRef = useRef(0);

  const sliderValue =
    dicom?.images?.length > 1
      ? (currentImageIndex / (dicom.images.length - 1)) * 100
      : 0;

  const handleSliderChange = (event, newValue) => {
    if (!dicom?.images?.length) return;
    const newIndex =
      dicom.images.length > 1
        ? Math.round((newValue / 100) * (dicom.images.length - 1))
        : 0;
    setCurrentImageIndex(newIndex);
  };

  // Use requestAnimationFrame for smoother playback with continuous looping
  const startPlayback = useCallback(() => {
    if (!dicom?.images?.length) return;
    if (playIntervalRef.current) {
      cancelAnimationFrame(playIntervalRef.current);
    }

    const frameTime = 80; // milliseconds per frame
    const advanceFrame = (timestamp) => {
      if (!isPlaying) return;

      const elapsed = timestamp - lastTimeRef.current;
      if (elapsed > frameTime) {
        lastTimeRef.current = timestamp;
        setCurrentImageIndex((prevIndex) => {
          // When reaching the end, loop back to beginning instead of stopping
          if (prevIndex < dicom.images.length - 1) {
            return prevIndex + 1;
          } else {
            // Loop back to beginning rather than stopping
            return 0;
          }
        });
      }
      if (isPlaying) {
        playIntervalRef.current = requestAnimationFrame(advanceFrame);
      }
    };

    lastTimeRef.current = performance.now();
    playIntervalRef.current = requestAnimationFrame(advanceFrame);

    return () => {
      if (playIntervalRef.current) {
        cancelAnimationFrame(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    };
  }, [dicom, isPlaying, setCurrentImageIndex]);

  useEffect(() => {
    if (isPlaying && !buttonsDisabled && dicom?.images?.length) {
      startPlayback();
    } else if (playIntervalRef.current) {
      cancelAnimationFrame(playIntervalRef.current);
      playIntervalRef.current = null;
    }
    return () => {
      if (playIntervalRef.current) {
        cancelAnimationFrame(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    };
  }, [isPlaying, dicom, startPlayback, buttonsDisabled]);

  // Auto-play on new DICOM load
  useEffect(() => {
    if (dicom?.dicomName && !buttonsDisabled) {
      setCurrentImageIndex(0);
      const timer = setTimeout(() => {
        setIsPlaying(true);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [dicom?.dicomName, setCurrentImageIndex, buttonsDisabled]);

  // Toggle playback with space bar
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'BUTTON' && !buttonsDisabled) {
        e.preventDefault();
        setIsPlaying((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line
  }, [buttonsDisabled, currentImageIndex, dicom]);

  if (!dicom || !dicom.images || dicom.images.length === 0) {
    return <div className="slider-empty">No images available</div>;
  }

  return (
    <ThemeProvider theme={muiTheme}>
      <div className="dicom-slider mui-slider">
        <div className="slider-with-controls">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Slider
              value={sliderValue}
              onChange={handleSliderChange}
              aria-label="DICOM image slider"
              valueLabelDisplay="off"
              track="normal"
              disabled={buttonsDisabled}
              sx={{ '& .MuiSlider-markLabel': { display: 'none' } }}
              onMouseDown={() => {
                // Pause playback when interacting with the slider.
                if (isPlaying) {
                  setIsPlaying(false);
                  if (playIntervalRef.current) {
                    cancelAnimationFrame(playIntervalRef.current);
                    playIntervalRef.current = null;
                  }
                }
              }}
            />
          </Box>

          {/* Play/Pause button */}
          <IconButton
            className="mui-playback-button play-pause"
            onClick={() => setIsPlaying((prev) => !prev)}
            aria-label={isPlaying ? "Pause" : "Play"}
            color="primary"
            size="medium"
            disabled={buttonsDisabled}
            sx={{ ml: 1 }}
          >
            {isPlaying ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </IconButton>
        </div>
      </div>
    </ThemeProvider>
  );
};

const CompletionModal = ({ count, onClose, onExport, loading }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content" onClick={e => e.stopPropagation()}>
      <div className="complete-message">
        <div className="complete-icon">✓</div>
        <h2>Labeling Complete!</h2>
        <p>You have labeled all {count} DICOMs. The labels have been saved to the server.</p>
        
        <div className="modal-buttons">
          <button className="button-primary" onClick={onExport} disabled={loading}>
            {loading ? 'Exporting...' : 'Export Final CSV'}
          </button>
          <button className="button-secondary" onClick={onClose}>
            Continue Viewing & Editing
          </button>
        </div>
      </div>
    </div>
  </div>
);

const LoadingSpinner = ({ text = "Processing Patient Dicoms ..." }) => (
  <div className="loading-overlay">
    <div className="loading-spinner"></div>
    <p>{text}</p>
  </div>
);

function App() {
  // Add new state for user authentication
  const [currentUser, setCurrentUser] = useState(null);
  
  // Patient metadata list (no images)
  const [patientsList, setPatientsList] = useState(null);
  const [directoryPath, setDirectoryPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  
  // Current patient with full data including images
  const [currentPatient, setCurrentPatient] = useState(null);
  const [selectedDicomIndex, setSelectedDicomIndex] = useState(0);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  
  const [count, setCount] = useState(0);
  const [overlay, setOverlay] = useState('');
  const [buttonsDisabled, setButtonsDisabled] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [apiStatus, setApiStatus] = useState({ loading: false, error: null });
  const [lastSelectedLabel, setLastSelectedLabel] = useState(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [butterflyDirectoryPath, setButterflyDirectoryPath] = useState('');
  const [vaveDirectoryPath, setVaveDirectoryPath] = useState('');
  const [hasShownCompletionModal, setHasShownCompletionModal] = useState(false);
  const [labelActionStack, setLabelActionStack] = useState([]);
  const [showUndoOverlay, setShowUndoOverlay] = useState(false);
  const [dropdownRenderKey, setDropdownRenderKey] = useState(0);
  const [isResetting, setIsResetting] = useState(false);

  
  const queueManagerRef = useRef(null);
  const labelTimeoutRef = useRef(null);
  const lastLabelActionRef = useRef(null);

  // Login handler
  const handleLogin = (username) => {
    setCurrentUser(username);
    // Reset the app state to load user-specific data
    setPatientsList(null);
    setCurrentPatient(null);
    setInitialLoading(true);
    loadUserData(username);
  };

  // Logout handler
  const handleLogout = () => {
    // Reset user authentication
    setCurrentUser(null);
    
    // Reset all application data
    setPatientsList(null);
    setCurrentPatient(null);
    setButterflyDirectoryPath('');
    setVaveDirectoryPath('');
    
    // Reset all UI state
    setSelectedDicomIndex(0);
    setCurrentImageIndex(0);
    setOverlay('');
    setCount(0);
    setIsComplete(false);
    setShowCompletionModal(false);
    setHasShownCompletionModal(false);
    setLoading(false);
    setLoadingImages(false);
    setScanProgress(0);
    setInitialLoading(true);
    setApiStatus({ loading: false, error: null });
    
    // Clear all label-related state
    setLastSelectedLabel(null);
    setLabelActionStack([]);
    
    // Reset all refs
    queueManagerRef.current = null;
    if (labelTimeoutRef.current) {
      clearTimeout(labelTimeoutRef.current);
      labelTimeoutRef.current = null;
    }
    lastLabelActionRef.current = null;
  };

  // Load user data
  const loadUserData = async (username) => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/fetch-csv?username=${username}`);
      
      if (response.data?.patients?.length > 0) {
        // Store only the metadata without images
        const patientsMetadata = response.data.patients.map(patient => ({
          ...patient,
          dicoms: patient.dicoms.map(dicom => {
            // Keep dicom metadata but remove any image data
            const dicomMeta = { ...dicom };
            delete dicomMeta.images;
            return dicomMeta;
          })
        }));
        
        setPatientsList(patientsMetadata);
      }
    } catch (error) {
      console.error("Error loading user data:", error);
    } finally {
      setLoading(false);
    }
  };

  const isDicomLabeled = dicom => dicom && dicom.label > 0;

  const isPatientFullyLabeled = patient => {
    // Add null/undefined check
    if (!patient || !patient.dicoms || patient.dicoms.length === 0) return false;
    
    // Explicitly check each dicom's label value, not using reference equality
    return patient.dicoms.every(dicom => dicom.label > 0);
  };
  
  const getTotalLabeledCount = () => {
    if (!patientsList) return 0;
    let count = 0;
    patientsList.forEach(patient => {
      patient.dicoms.forEach(dicom => {
        if (isDicomLabeled(dicom)) count++;
      });
    });
    return count;
  };

  const getTotalDicomCount = () => {
    if (!patientsList) return 0;
    let count = 0;
    patientsList.forEach(patient => {
      count += patient.dicoms.length;
    });
    return count;
  };

  // Natural sorting function for patient names
  const naturalSort = (a, b) => {
    // Extract the first number from each name, matching backend logic
    const aMatch = a.match(/\d+/);
    const bMatch = b.match(/\d+/);
    
    // If both have numbers, compare numerically (primary sort)
    if (aMatch && bMatch) {
      return parseInt(aMatch[0]) - parseInt(bMatch[0]);
    }
    
    // If only one has a number, the one with a number comes first
    if (aMatch) return -1;
    if (bMatch) return 1;
    
    // If neither has a number, fall back to alphabetical comparison
    return a.localeCompare(b);
  };

  // Updated Reset All Labels function with proper dropdown UI updates
  // Simple fixed resetAllLabels function
  const resetAllLabels = async () => {
  if (!currentUser) return;
  
  // Confirm before proceeding
  if (!window.confirm("Are you sure you want to reset all labels? This will reset all your progress.")) {
    return;
  }
  
  // Set the resetting flag to true - this prevents the effect from running prematurely
  setIsResetting(true);
  
  // Disable UI during operation
  setButtonsDisabled(true);
  setApiStatus({ loading: true, error: null });
  
  try {
    // 1. Update the backend
    const updatePromises = [];
    for (const patient of patientsList) {
      for (const dicom of patient.dicoms) {
        updatePromises.push(
          axios.post(`${API_URL}/update-csv`, {
            patientName: patient.patientName,
            dicomName: dicom.dicomName,
            label: 0,
            username: currentUser
          })
        );
      }
    }
    
    // Wait for backend updates to complete
    await Promise.all(updatePromises);
    
    // 2. Update local state
    const resetPatientsList = patientsList.map(patient => ({
      ...patient,
      dicoms: patient.dicoms.map(dicom => ({
        ...dicom,
        label: 0
      }))
    }));
    
    // Reset all state
    setPatientsList(resetPatientsList);
    setCount(0);
    setIsComplete(false);
    setHasShownCompletionModal(false);
    setLastSelectedLabel(null);
    setLabelActionStack([]);
    
    // Clear any active timeouts
    if (labelTimeoutRef.current) {
      clearTimeout(labelTimeoutRef.current);
      labelTimeoutRef.current = null;
    }
    lastLabelActionRef.current = null;
    
    // 3. Create new queue manager
    queueManagerRef.current = new DicomQueueManager({ patients: resetPatientsList });
    
    // Success message
    setApiStatus({ 
      loading: false, 
      error: null, 
      success: "All labels have been reset successfully" 
    });
    
    setTimeout(() => {
      setApiStatus(prev => ({ ...prev, success: null }));
    }, 3000);
    
  } catch (error) {
    console.error("Error resetting labels:", error);
    setApiStatus({ 
      loading: false, 
      error: "Failed to reset labels. Please try again." 
    });
  } finally {
    // Re-enable UI
    setButtonsDisabled(false);
    
    // IMPORTANT: Set the resetting flag to false AFTER everything else is done
    // This will trigger the effect to navigate to the first patient
    setIsResetting(false);
  }
};
  
  // Updated Start Over function to clear all application state
  const startOver = async () => {
    if (!currentUser) return;
    
    // Confirm before proceeding with stronger warning
    if (!window.confirm("WARNING: This will remove all DICOM data and all user data from the application. Are you sure you want to do this?")) {
      return;
    }
    
    setApiStatus({ loading: true, error: null });
    
    try {
      // Call backend to delete the CSV file - pass delete_all=true parameter
      await axios.get(`${API_URL}/reset-csv?username=${currentUser}&delete_all=true`);
      
      // Reset all state variables to initial values
      setPatientsList(null);
      setCurrentPatient(null);
      setButterflyDirectoryPath('');
      setVaveDirectoryPath('');
      setSelectedDicomIndex(0);
      setCurrentImageIndex(0);
      setOverlay('');
      setCount(0);
      setIsComplete(false);
      setHasShownCompletionModal(false);
      setLoading(false);
      setLoadingImages(false);
      setScanProgress(0);
      setInitialLoading(true);
      setApiStatus({ loading: false, error: null });
      
      // Clear all label-related state
      setLastSelectedLabel(null);
      setLabelActionStack([]);
      if (labelTimeoutRef.current) {
        clearTimeout(labelTimeoutRef.current);
        labelTimeoutRef.current = null;
      }
      lastLabelActionRef.current = null;
      
      // Clear the queue manager
      queueManagerRef.current = null;
      
      // IMPORTANT: Log the user out by setting currentUser to null
      setCurrentUser(null);
      
    } catch (error) {
      console.error("Error starting over:", error);
      // Even if the backend reset fails, make sure to reset the loading states
      setApiStatus({ 
        loading: false, 
        error: "Failed to reset server data. The app has been reset locally." 
      });
      
      // Reset UI state anyway to prevent user from being stuck
      setPatientsList(null);
      setCurrentPatient(null);
      setLoading(false);
      setLoadingImages(false);
      setScanProgress(0);
      
      // Clear all label-related state
      setLastSelectedLabel(null);
      setLabelActionStack([]);
      if (labelTimeoutRef.current) {
        clearTimeout(labelTimeoutRef.current);
        labelTimeoutRef.current = null;
      }
      lastLabelActionRef.current = null;
      
      // Still log the user out even if there was an error
      setCurrentUser(null);
    }
  };

  const handleScanDirectory = async () => {
    if (!butterflyDirectoryPath && !vaveDirectoryPath) {
      alert("Please enter at least one directory path");
      return;
    }

    if (!currentUser) {
      alert("You must be logged in to scan directories");
      return;
    }

    // Reset any existing error states and set loading to true
    setApiStatus({ loading: false, error: null });
    setLoading(true);
    setScanProgress(0);

    // Clear any existing progress interval to prevent memory leaks
    let progressInterval;

    try {
      // Start progress indicator
      progressInterval = setInterval(() => {
        setScanProgress(prev => {
          // Only increment up to 90% - the last 10% is for actual completion
          return prev < 90 ? prev + 5 : prev;
        });
      }, 300);

      // Send directory paths and username in the POST request
      const response = await axios.post(`${API_URL}/scan-directory`, {
        butterfly_directory_path: butterflyDirectoryPath,
        vave_directory_path: vaveDirectoryPath,
        username: currentUser
      });

      // Stop the progress indicator
      clearInterval(progressInterval);
      progressInterval = null;
      
      // Set to 100% to indicate completion
      setScanProgress(100);

      if (response.data && response.data.patients) {
        setPatientsList(response.data.patients);
      } else {
        throw new Error("Folder structure invalid or no DICOMs found.");
      }
    } catch (error) {
      console.error("Error scanning directories:", error);
      
      // Clear the progress interval
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
      
      // Set progress to 0 to indicate failure
      setScanProgress(0);
      
      // Show detailed error message
      let errorMessage = "Error scanning directories. ";
      
      if (error.response?.data?.detail) {
        errorMessage += error.response.data.detail;
      } else if (error.message) {
        errorMessage += error.message;
      } else {
        errorMessage += "Please verify your directory paths and try again.";
      }
      
      alert(errorMessage);
    } finally {
      // Always ensure loading is set to false to prevent UI from being stuck
      setLoading(false);
    }
  };

  // Initialize queue manager when patients list is loaded
  useEffect(() => {
    if (patientsList && initialLoading) {
      // Create a new queue manager with the patients list
      queueManagerRef.current = new DicomQueueManager({ patients: patientsList });
      
      // Get the first item from the queue
      const nextItem = queueManagerRef.current.getNext();
      
      if (nextItem) {
        // Load the first patient from the queue
        fetchPatientDicoms(nextItem.patientName, nextItem.dicom.dicomName);
      } else if (patientsList.length > 0) {
        // If queue is empty but we have patients, load the first one
        fetchPatientDicoms(patientsList[0].patientName);
      }
      
      // Update counters
      setCount(getTotalLabeledCount());
      
      // Exact comparison for isComplete check, not >=
      const totalDicoms = getTotalDicomCount();
      const labeledDicoms = getTotalLabeledCount();
      setIsComplete(totalDicoms > 0 && labeledDicoms === totalDicoms);
      
      setInitialLoading(false);
    }
    // eslint-disable-next-line
  }, [patientsList]);

  useEffect(() => {
    // This effect only runs after reset is complete
    if (isResetting === false && patientsList && patientsList.length > 0) {
      // Sort patients naturally to get the first one
      const sortedPatients = [...patientsList].sort((a, b) => 
        naturalSort(a.patientName, b.patientName)
      );
      
      if (sortedPatients.length > 0) {
        const firstPatient = sortedPatients[0];
        const firstPatientIndex = patientsList.findIndex(p => p.patientName === firstPatient.patientName);
        
        // Use the same patient change handler we use elsewhere
        handlePatientChange({ target: { value: firstPatientIndex } });
      }
    }
  }, [isResetting]);

  useEffect(() => {
    if (patientsList) {
      // Get the current counts
      const totalDicoms = getTotalDicomCount();
      const labeledDicoms = getTotalLabeledCount();
      
      // Check if all DICOMs are labeled
      const allLabeled = totalDicoms > 0 && labeledDicoms === totalDicoms;
      
      // Update isComplete state
      setIsComplete(allLabeled);
      
      // If we just reached completion and haven't shown the modal yet
      if (allLabeled && !hasShownCompletionModal) {
        setShowCompletionModal(true);
        setHasShownCompletionModal(true);
      }
      
      // If we're no longer complete, reset the shown flag
      if (!allLabeled && hasShownCompletionModal) {
        setHasShownCompletionModal(false);
      }
    }
  }, [patientsList, hasShownCompletionModal]);

  // Modified to load user-specific data
  useEffect(() => {
    // Only try to load initial data if there's no current user
    // User data will be loaded by handleLogin when a user logs in
    if (!currentUser) return;
    
    const loadInitialData = async () => {
      try {
        setLoading(true);
        const response = await axios.get(`${API_URL}/fetch-csv?username=${currentUser}`);
        
        if (response.data?.patients?.length > 0) {
          // Store only the metadata without images
          const patientsMetadata = response.data.patients.map(patient => ({
            ...patient,
            dicoms: patient.dicoms.map(dicom => {
              // Keep dicom metadata but remove any image data
              const dicomMeta = { ...dicom };
              delete dicomMeta.images;
              return dicomMeta;
            })
          }));
          
          setPatientsList(patientsMetadata);
        }
      } catch (error) {
        console.error("Error loading initial data:", error);
      } finally {
        setLoading(false);
      }
    };
    
    loadInitialData();
  }, [currentUser]);

  const fetchPatientDicoms = async (patientName, initialDicomName = null) => {
    if (!currentUser) return;
    
    setLoadingImages(true);
    
    try {
      console.log(`Loading DICOMs for patient: ${patientName}`);
      
      const response = await axios.post(`${API_URL}/fetch-patient-dicoms`, { 
        patientName,
        username: currentUser
      });
      
      if (response.data && response.data.dicoms) {
        // Find the patient in our metadata list
        const patientIndex = patientsList.findIndex(p => p.patientName === patientName);
        
        if (patientIndex === -1) {
          throw new Error(`Patient ${patientName} not found in patient list`);
        }
        
        // Get patient metadata
        const patientMeta = patientsList[patientIndex];
        
        // Create a new patient object with the fetched DICOM images
        const fullPatient = {
          ...patientMeta,
          dicoms: patientMeta.dicoms.map(dicom => {
            const fetchedDicom = response.data.dicoms.find(d => d.dicomName === dicom.dicomName);
            
            if (fetchedDicom && fetchedDicom.images) {
              return { ...dicom, images: fetchedDicom.images };
            }
            return dicom;
          })
        };
        
        // Set as current patient
        setCurrentPatient(fullPatient);
        
        // Find the initial DICOM to display
        let initialDicomIndex = 0;
        
        if (initialDicomName) {
          // If a specific DICOM is requested, use that
          const foundIndex = fullPatient.dicoms.findIndex(d => d.dicomName === initialDicomName);
          if (foundIndex !== -1) {
            initialDicomIndex = foundIndex;
          }
        } else if (queueManagerRef.current) {
          // Otherwise use the first unlabeled DICOM from this patient in the queue
          const nextItem = queueManagerRef.current.unlabeledQueue.find(
            item => item.patientName === patientName
          );
          
          if (nextItem) {
            const unlabeledIndex = fullPatient.dicoms.findIndex(
              d => d.dicomName === nextItem.dicom.dicomName
            );
            
            if (unlabeledIndex !== -1) {
              initialDicomIndex = unlabeledIndex;
            }
          }
        }
        
        // Set the selected DICOM index
        setSelectedDicomIndex(initialDicomIndex);
        setCurrentImageIndex(0);
        setLastSelectedLabel(fullPatient.dicoms[initialDicomIndex].label || null);
        
        console.log(`Successfully loaded DICOMs for patient: ${patientName}`);
        return true;
      } else {
        throw new Error("Invalid response from server");
      }
    } catch (error) {
      console.error(`Error loading DICOMs for patient ${patientName}:`, error);
      alert(`Error loading data for patient ${patientName}. Please try again.`);
      return false;
    } finally {
      setLoadingImages(false);
    }
  };

  // Patient change handler
  const handlePatientChange = (e) => {
    if (buttonsDisabled || !queueManagerRef.current || !patientsList) return;
    
    const newPatientIndex = Number(e.target.value);
    if (newPatientIndex < 0 || newPatientIndex >= patientsList.length) return;
    
    const patientName = patientsList[newPatientIndex].patientName;
    
    // Prioritize this patient's DICOMs in the queue
    queueManagerRef.current.prioritizePatient(patientName);
    
    // Load the selected patient with its DICOMs
    fetchPatientDicoms(patientName);
  };

  // DICOM change handler
  const handleDicomChange = (e) => {
    if (buttonsDisabled || !queueManagerRef.current || !currentPatient) return;
    
    const newDicomIndex = Number(e.target.value);
    
    if (newDicomIndex < 0 || newDicomIndex >= currentPatient.dicoms.length) return;
    
    const patientName = currentPatient.patientName;
    const dicomName = currentPatient.dicoms[newDicomIndex].dicomName;
    
    // Update UI to show the selected DICOM
    setSelectedDicomIndex(newDicomIndex);
    setCurrentImageIndex(0);
    
    // Prioritize this specific DICOM in the queue
    queueManagerRef.current.prioritizeSpecificDicom(patientName, dicomName);
    
    // Update last selected label
    setLastSelectedLabel(currentPatient.dicoms[newDicomIndex].label || null);
  };

  const advanceToNextInQueue = () => {
    if (!queueManagerRef.current || !patientsList) return false;
    
    const nextItem = queueManagerRef.current.getNext();
    
    if (nextItem) {
      // Check if we need to load a different patient
      if (!currentPatient || nextItem.patientName !== currentPatient.patientName) {
        // Before loading a new patient, check if there are any remaining unlabeled DICOMs
        // for the current patient that might not be at the front of the queue
        if (currentPatient) {
          const remainingUnlabeledForCurrentPatient = queueManagerRef.current.getTotalUnlabeledCountForPatient(currentPatient.patientName);
          
          if (remainingUnlabeledForCurrentPatient > 0) {
            // If there are still unlabeled DICOMs for the current patient,
            // prioritize this patient to bring those to the front of the queue
            const prioritizedItem = queueManagerRef.current.prioritizePatient(currentPatient.patientName);
            
            if (prioritizedItem) {
              // Just update the DICOM index since we're staying with the current patient
              const prioritizedDicomIndex = currentPatient.dicoms.findIndex(
                d => d.dicomName === prioritizedItem.dicom.dicomName
              );
              
              if (prioritizedDicomIndex !== -1) {
                setSelectedDicomIndex(prioritizedDicomIndex);
                setCurrentImageIndex(0);
                setLastSelectedLabel(prioritizedItem.dicom.label || null);
                return true;
              }
            }
          }
        }
        
        // No remaining unlabeled DICOMs for current patient, load the next patient
        console.log(`Loading next patient from queue: ${nextItem.patientName}`);
        fetchPatientDicoms(nextItem.patientName, nextItem.dicom.dicomName);
      } else {
        // Same patient, just update the DICOM index
        const nextDicomIndex = currentPatient.dicoms.findIndex(
          d => d.dicomName === nextItem.dicom.dicomName
        );
        
        if (nextDicomIndex !== -1) {
          setSelectedDicomIndex(nextDicomIndex);
          setCurrentImageIndex(0);
          setLastSelectedLabel(nextItem.dicom.label || null);
        }
      }
      
      return true;
    }
    
    return false;
  };

  const renderPatientDropdown = () => {
    // Create fresh options directly from current state data
    const freshPatientOptions = patientsList.map(patient => ({
      name: patient.patientName,
      patient: patient
    }));
    
    return (
      <CustomDropdown
        label="Patient"
        options={freshPatientOptions}
        value={freshPatientOptions.findIndex(option => 
          option.name === currentPatient?.patientName
        )}
        onChange={handlePatientChange}
        disabled={buttonsDisabled}
        loading={loadingImages}
        isLabeledFn={(option) => {
          // Explicitly check the label status from patientsList data, not from option reference
          if (!option.patient) return false;
          
          const patientData = patientsList.find(p => p.patientName === option.patient.patientName);
          if (!patientData) return false;
          
          return patientData.dicoms.every(dicom => dicom.label > 0);
        }}
      />
    );
  };

  const renderDicomDropdown = () => {
    // Create fresh options directly from current state data
    const freshDicomOptions = currentPatient ? currentPatient.dicoms.map(dicom => ({
      name: dicom.dicomName,
      dicom: dicom
    })) : [];
    
    return (
      <CustomDropdown
        key={`dicom-dropdown-${dropdownRenderKey}`} // Add key here
        label="DICOM"
        options={freshDicomOptions}
        value={selectedDicomIndex}
        onChange={handleDicomChange}
        disabled={buttonsDisabled || loadingImages}
        isLabeledFn={(option) => {
          // Explicitly check the label status from current data, not from option reference
          if (!option.dicom) return false;
          
          // Find the dicom in the current patient to get the latest state
          const currentDicomData = currentPatient?.dicoms?.find(d => 
            d.dicomName === option.dicom.dicomName
          );
          
          return currentDicomData ? currentDicomData.label > 0 : false;
        }}
      />
    );
  };

  const updateBackendWithLabel = async (patientName, dicomName, label) => {
    if (!currentUser) return;
    
    try {
      setApiStatus({ loading: true, error: null });
      
      const updateRequest = { 
        patientName, 
        dicomName, 
        label,
        username: currentUser 
      };
      await axios.post(`${API_URL}/update-csv`, updateRequest);
      
      setApiStatus({ loading: false, error: null });
    } catch (error) {
      console.error("Error updating backend CSV:", error);
      setApiStatus({ 
        loading: false, 
        error: "Failed to update server. Your labels are saved in the browser." 
      });
    }
  };

  // Label handler
  const handleLabel = (label) => {
    if (buttonsDisabled || !queueManagerRef.current || !currentPatient) return;
    
    const labelInt = parseInt(label, 10);
    
    // Get current DICOM
    const currentDicom = currentPatient.dicoms[selectedDicomIndex];
    
    // If the DICOM already has this label, don't do anything
    if (currentDicom.label === labelInt) return;
    
    // Disable buttons and show overlay
    setButtonsDisabled(true);
    setOverlay(label);
    
    const labelAction = {
      dicomIndex: selectedDicomIndex,
      previousLabel: currentDicom.label,
      patientName: currentPatient.patientName,
      dicomName: currentDicom.dicomName,
      newLabel: labelInt
    };
    
    // Store in ref for immediate timeout-based undo
    lastLabelActionRef.current = labelAction;
    
    // Add to the undo stack
    setLabelActionStack(prevStack => [...prevStack, labelAction]);
    
    // Keep track of the selected label
    setLastSelectedLabel(labelInt);
    
    // Check if this was already labeled
    const wasAlreadyLabeled = isDicomLabeled(currentDicom);
    
    // Update current patient state with new label for the DICOM
    setCurrentPatient(prevPatient => {
      const updatedPatient = { ...prevPatient };
      const updatedDicoms = [...updatedPatient.dicoms];
      const updatedDicom = { ...updatedDicoms[selectedDicomIndex], label: labelInt };
      
      updatedDicoms[selectedDicomIndex] = updatedDicom;
      updatedPatient.dicoms = updatedDicoms;
      
      return updatedPatient;
    });
    
    // Also update the patients list metadata to keep it in sync
    setPatientsList(prevList => {
      if (!prevList) return prevList;
      
      const newList = [...prevList];
      const patientIndex = newList.findIndex(p => p.patientName === currentPatient.patientName);
      
      if (patientIndex !== -1) {
        const patient = { ...newList[patientIndex] };
        const dicomIndex = patient.dicoms.findIndex(d => d.dicomName === currentDicom.dicomName);
        
        if (dicomIndex !== -1) {
          const dicom = { ...patient.dicoms[dicomIndex], label: labelInt };
          patient.dicoms[dicomIndex] = dicom;
          newList[patientIndex] = patient;
        }
      }
      
      return newList;
    });
    
    // Update the queue manager with the new label
    queueManagerRef.current.updateDicomLabel(
      currentPatient.patientName,
      currentDicom.dicomName,
      labelInt
    );
    
    // Update the backend
    updateBackendWithLabel(
      currentPatient.patientName,
      currentDicom.dicomName,
      labelInt
    );
    
    // Only increment count if this is a newly labeled DICOM
    if (!wasAlreadyLabeled) {
      setCount(prev => prev + 1);
    }
    
    // Clear any existing timeout
    if (labelTimeoutRef.current) {
      clearTimeout(labelTimeoutRef.current);
    }
    
    // Show overlay briefly then proceed to next DICOM
    labelTimeoutRef.current = setTimeout(() => {
      setOverlay('');
      
      // Process post-labeling queue updates and get next DICOM
      const nextItem = queueManagerRef.current.handlePostLabeling(
        currentPatient.patientName,
        currentDicom.dicomName,
        wasAlreadyLabeled
      );
      
      let moved = false;
      
      if (nextItem) {
        // Check if next item is from the current patient or a different one
        if (nextItem.patientName !== currentPatient.patientName) {
          // Before loading a new patient, check if there are any remaining unlabeled DICOMs
          // for the current patient that might not be at the front of the queue
          const remainingUnlabeledForCurrentPatient = queueManagerRef.current.getTotalUnlabeledCountForPatient(currentPatient.patientName);
          
          if (remainingUnlabeledForCurrentPatient > 0) {
            // If there are still unlabeled DICOMs for the current patient,
            // prioritize this patient to bring those to the front of the queue
            const prioritizedItem = queueManagerRef.current.prioritizePatient(currentPatient.patientName);
            
            if (prioritizedItem) {
              // Just update the DICOM index since we're staying with the current patient
              const prioritizedDicomIndex = currentPatient.dicoms.findIndex(
                d => d.dicomName === prioritizedItem.dicom.dicomName
              );
              
              if (prioritizedDicomIndex !== -1) {
                setSelectedDicomIndex(prioritizedDicomIndex);
                setCurrentImageIndex(0);
                setLastSelectedLabel(prioritizedItem.dicom.label || null);
                moved = true;
              }
            }
          } else {
            // No unlabeled DICOMs left for current patient, load the next patient
            console.log(`No more unlabeled DICOMs for ${currentPatient.patientName}, loading ${nextItem.patientName}`);
            fetchPatientDicoms(nextItem.patientName, nextItem.dicom.dicomName);
            moved = true;
          }
        } else {
          // Same patient, just update the DICOM index
          const nextDicomIndex = currentPatient.dicoms.findIndex(
            d => d.dicomName === nextItem.dicom.dicomName
          );
          
          if (nextDicomIndex !== -1) {
            setSelectedDicomIndex(nextDicomIndex);
            setCurrentImageIndex(0);
            setLastSelectedLabel(nextItem.dicom.label || null);
            moved = true;
          }
        }
      }
      
      // If no movement happened, try to advance to the next in queue
      if (!moved) {
        moved = advanceToNextInQueue();
      }
      
      setButtonsDisabled(false);
      labelTimeoutRef.current = null;
      lastLabelActionRef.current = null;
    }, 400);
  };

  const undoLabel = async () => {
    // Exit silently if there's nothing to undo
    if (labelActionStack.length === 0 && !labelTimeoutRef.current) {
      return;
    }
    
    // Show the undo overlay immediately
    setShowUndoOverlay(true);
    
    // First handle the immediate undo case (during the timeout)
    if (labelTimeoutRef.current && lastLabelActionRef.current) {
      clearTimeout(labelTimeoutRef.current);
      labelTimeoutRef.current = null;
      
      setOverlay('');
      setButtonsDisabled(true);
      
      const { 
        dicomIndex, 
        previousLabel, 
        patientName, 
        dicomName 
      } = lastLabelActionRef.current;
      
      setLastSelectedLabel(previousLabel || null);
      
      const dicom = currentPatient.dicoms[dicomIndex];
      const currentlyLabeled = isDicomLabeled(dicom);
      const wouldBeUnlabeled = !previousLabel || previousLabel === 0;
      
      // Update the current patient
      setCurrentPatient(prevPatient => {
        const updatedPatient = { ...prevPatient };
        const updatedDicoms = [...updatedPatient.dicoms];
        const updatedDicom = { ...updatedDicoms[dicomIndex], label: previousLabel || 0 };
        
        updatedDicoms[dicomIndex] = updatedDicom;
        updatedPatient.dicoms = updatedDicoms;
        
        return updatedPatient;
      });
      
      // Also update the patients list metadata
      setPatientsList(prevList => {
        if (!prevList) return prevList;
        
        const newList = [...prevList];
        const patientIndex = newList.findIndex(p => p.patientName === patientName);
        
        if (patientIndex !== -1) {
          const patient = { ...newList[patientIndex] };
          const dicomIndex = patient.dicoms.findIndex(d => d.dicomName === dicomName);
          
          if (dicomIndex !== -1) {
            const dicom = { ...patient.dicoms[dicomIndex], label: previousLabel || 0 };
            patient.dicoms[dicomIndex] = dicom;
            newList[patientIndex] = patient;
          }
        }
        
        return newList;
      });
      
      // Update the dicom's label in the queue manager
      queueManagerRef.current.updateDicomLabel(patientName, dicomName, previousLabel || 0);
      
      // If the dicom is now unlabeled (label === 0), prioritize it in the queue
      if (wouldBeUnlabeled) {
        queueManagerRef.current.prioritizeSpecificDicom(patientName, dicomName);
      }
      
      await updateBackendWithLabel(patientName, dicomName, previousLabel || 0);
      
      if (currentlyLabeled && wouldBeUnlabeled) {
        setCount(prev => prev - 1);
      }
      
      lastLabelActionRef.current = null;
      
      // Also remove this action from the stack
      setLabelActionStack(prevStack => {
        if (prevStack.length === 0) return prevStack;
        return prevStack.slice(0, -1);
      });
      
      // Hide the undo overlay after a delay and re-enable buttons
      setTimeout(() => {
        setShowUndoOverlay(false);
        setButtonsDisabled(false);
      }, 400);
      
      return;
    }
    
    // Now handle the stack-based undo case
    if (labelActionStack.length > 0) {
      // Get the most recent action
      const lastAction = labelActionStack[labelActionStack.length - 1];
      
      // Remove this action from the stack
      setLabelActionStack(prevStack => prevStack.slice(0, -1));
      
      const { 
        patientName, 
        dicomName, 
        previousLabel 
      } = lastAction;
      
      // Disable buttons during operation
      setButtonsDisabled(true);
      setApiStatus({ loading: true, error: null });
      
      try {
        // Always update the backend first
        await updateBackendWithLabel(patientName, dicomName, previousLabel || 0);
        console.log(`Updated backend for ${patientName}/${dicomName} to label ${previousLabel || 0}`);
        
        // Update the patients list - always needed regardless of which patient
        setPatientsList(prevList => {
          if (!prevList) return prevList;
          
          const newList = [...prevList];
          const patientIndex = newList.findIndex(p => p.patientName === patientName);
          
          if (patientIndex !== -1) {
            const patient = { ...newList[patientIndex] };
            const dicomIndex = patient.dicoms.findIndex(d => d.dicomName === dicomName);
            
            if (dicomIndex !== -1) {
              // Get the current label to calculate the count update
              const currentlyLabeled = isDicomLabeled(patient.dicoms[dicomIndex]);
              const wouldBeUnlabeled = !previousLabel || previousLabel === 0;
              
              // Update the dicom's label
              const dicom = { ...patient.dicoms[dicomIndex], label: previousLabel || 0 };
              patient.dicoms[dicomIndex] = dicom;
              newList[patientIndex] = patient;
              
              // Update count if needed
              if (currentlyLabeled && wouldBeUnlabeled) {
                setCount(prev => prev - 1);
              } else if (!currentlyLabeled && !wouldBeUnlabeled) {
                setCount(prev => prev + 1);
              }
            }
          }
          
          return newList;
        });
        
        // Update the queue manager - always needed regardless of which patient
        queueManagerRef.current.updateDicomLabel(patientName, dicomName, previousLabel || 0);
        
        // If the dicom is now unlabeled (label === 0), prioritize it in the queue
        const wouldBeUnlabeled = !previousLabel || previousLabel === 0;
        if (wouldBeUnlabeled) {
          queueManagerRef.current.prioritizeSpecificDicom(patientName, dicomName);
        }
        
        // Now check if we need to load a different patient
        if (!currentPatient || currentPatient.patientName !== patientName) {
          // Need to load the other patient
          console.log(`Loading different patient for undo: ${patientName}`);
          await fetchPatientDicoms(patientName, dicomName);
          
          // After loading, find the specific DICOM
          if (currentPatient && currentPatient.dicoms) {
            const targetDicomIndex = currentPatient.dicoms.findIndex(d => d.dicomName === dicomName);
            if (targetDicomIndex !== -1) {
              setSelectedDicomIndex(targetDicomIndex);
              setCurrentImageIndex(0);
            }
          }
        } else {
          // Same patient, just find and select the right DICOM
          const targetDicomIndex = currentPatient.dicoms.findIndex(d => d.dicomName === dicomName);
          if (targetDicomIndex !== -1) {
            // Update the current patient's DICOM label directly
            setCurrentPatient(prevPatient => {
              const updatedPatient = { ...prevPatient };
              const updatedDicoms = [...updatedPatient.dicoms];
              const updatedDicom = { ...updatedDicoms[targetDicomIndex], label: previousLabel || 0 };
              
              updatedDicoms[targetDicomIndex] = updatedDicom;
              updatedPatient.dicoms = updatedDicoms;
              
              return updatedPatient;
            });
            
            // Switch to this DICOM if not already selected
            if (targetDicomIndex !== selectedDicomIndex) {
              setSelectedDicomIndex(targetDicomIndex);
              setCurrentImageIndex(0);
            }
          }
        }
        
        // Success message
        setApiStatus({ 
          loading: false, 
          error: null, 
          success: `Undid labeling for ${dicomName}` 
        });
        setTimeout(() => setApiStatus(prev => ({ ...prev, success: null })), 3000);
      } catch (error) {
        console.error("Error during undo operation:", error);
        setApiStatus({ 
          loading: false, 
          error: "Failed to undo the label. Please try again." 
        });
      } finally {
        // Hide the undo overlay and re-enable buttons after a delay
        setTimeout(() => {
          setShowUndoOverlay(false);
          setButtonsDisabled(false);
        }, 400);
      }
    }
  };

  const getLabelClass = (labelNum) => {
    const currentDicom = currentPatient?.dicoms?.[selectedDicomIndex];
    
    if (buttonsDisabled && lastSelectedLabel === labelNum) {
      return "label-button active";
    }
    
    return (!currentDicom || !currentDicom.label) 
      ? "label-button" 
      : (currentDicom.label === labelNum ? "label-button active" : "label-button");
  };

  // Key event handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (showCompletionModal) return;
      
      console.log("Key pressed:", e.key);
      console.log("Keycode pressed: ", e.keyCode);

      if (['1','2','3','4','5'].includes(e.key)) {
        handleLabel(e.key);
      } else if (e.keyCode === 8) {
        undoLabel();
      } else if (e.keyCode === 37) {
        setCurrentImageIndex(prev => Math.max(0, prev - 1));
      } else if (e.keyCode === 39) {
        const dicom = currentPatient?.dicoms?.[selectedDicomIndex];
        if (dicom?.images) {
          setCurrentImageIndex(prev => Math.min(dicom.images.length - 1, prev + 1));
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line
  }, [buttonsDisabled, showCompletionModal, currentPatient, selectedDicomIndex, currentImageIndex]);

  useEffect(() => {
    if (patientsList) {
      // Get the current counts
      const totalDicoms = getTotalDicomCount();
      const labeledDicoms = getTotalLabeledCount();
      
      // Only set as complete if all DICOMs are labeled (exact match)
      if (totalDicoms > 0 && labeledDicoms === totalDicoms) {
        setIsComplete(true);
        
        // Only trigger the completion modal once automatically
        // and only if it hasn't been manually dismissed
        if (!isComplete && !showCompletionModal) {
          setShowCompletionModal(true);
        }
      } else {
        // Make sure to set this to false if the condition no longer meets
        // (For example if a label is undone)
        setIsComplete(false);
      }
    }
  }, [patientsList, isComplete, showCompletionModal]);

  const exportCSV = async () => {
    if (!currentUser) return;
    
    try {
      setApiStatus({ loading: true, error: null });
      
      const response = await axios.get(`${API_URL}/fetch-csv?username=${currentUser}`);
      
      if (!response.data) {
        throw new Error("Invalid response from server");
      }
      
      let csvContent = "data:text/csv;charset=utf-8,";
      csvContent += "PatientName,DicomName,Label\r\n";
      
      const patientsData = response.data.patients || [];
      
      patientsData.forEach(patient => {
        patient.dicoms.forEach(dicom => {
          csvContent += [patient.patientName, dicom.dicomName, dicom.label || 0].join(",") + "\r\n";
        });
      });
      
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `echocardiogram_labels_${currentUser}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setApiStatus({ loading: false, error: null });
    } catch (error) {
      console.error("Error exporting CSV:", error);
      setApiStatus({ loading: false, error: "Failed to export CSV. Please try again." });
      alert("Error exporting CSV. Please try again.");
    }
  };

  // Render function with login screen
  if (!currentUser) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (!patientsList) {
    return (
      <div className="upload-container">
        <div className="upload-card">
          <div className="user-header">
            <h1>Echocardiogram Labeler</h1>
            <div className="user-info">
              <span>Logged in as: <strong>{currentUser}</strong></span>
              <button className="logout-button" onClick={handleLogout}>Logout</button>
            </div>
          </div>
          <div className="upload-area">
            {loading ? (
              <div className="progress-container">
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${scanProgress}%` }}></div>
                </div>
                <p>Scanning Directories... {scanProgress}%</p>
              </div>
            ) : (
              <>
                <div className="upload-icon">
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                </div>
                <div className="directory-input">
                  <label htmlFor="butterfly-directory-path">Butterfly DICOM Directory Path:</label>
                  <input
                    id="butterfly-directory-path"
                    type="text"
                    value={butterflyDirectoryPath}
                    onChange={(e) => setButterflyDirectoryPath(e.target.value)}
                    placeholder="e.g., C:\path\to\butterfly_DICOM_folder"
                    className="directory-path-input"
                  />
                </div>
                <div className="directory-input">
                  <label htmlFor="vave-directory-path">Vave DICOM Directory Path:</label>
                  <input
                    id="vave-directory-path"
                    type="text"
                    value={vaveDirectoryPath}
                    onChange={(e) => setVaveDirectoryPath(e.target.value)}
                    placeholder="e.g., C:\path\to\vave_DICOM_folder"
                    className="directory-path-input"
                  />
                </div>
                <button 
                  className="scan-button"
                  onClick={handleScanDirectory}
                  disabled={loading || (!butterflyDirectoryPath && !vaveDirectoryPath)}
                >
                  Scan Directories
                </button>
                <p className="upload-hint">
                  Enter the absolute paths to the folders containing patient folders and DICOM files.
                  At least one path is required.
                </p>
                <p className="upload-info">
                  Previous labels will be used if available.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  
  // If we have patient list but current patient hasn't loaded yet
  if (!currentPatient) {
    return (
      <div className="upload-container">
        <div className="upload-card">
          <div className="user-header">
            <h1>Echocardiogram Labeler</h1>
            <div className="user-info">
              <span>Logged in as: <strong>{currentUser}</strong></span>
              <button className="logout-button" onClick={handleLogout}>Logout</button>
            </div>
          </div>
          <div className="upload-area">
            <LoadingSpinner text="Loading patient data..." />
          </div>
        </div>
      </div>
    );
  }

  // Current DICOM from loaded patient
  const currentDicom = currentPatient.dicoms[selectedDicomIndex];
  
  // Options for patient dropdown - from the metadata list
  const patientOptions = patientsList.map(patient => ({
    name: patient.patientName,
    patient: patient
  }));
  
  // Options for DICOM dropdown - from current patient
  const dicomOptions = currentPatient.dicoms.map(dicom => ({
    name: dicom.dicomName,
    dicom: dicom
  }));

  const unlabeledRemaining = getTotalDicomCount() - getTotalLabeledCount();
  const currentImage = currentDicom.images && currentDicom.images.length > 0 
    ? currentDicom.images[currentImageIndex] 
    : null;

  return (
    <div className="app-container">
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
      
      <div className="main-content" style={{ display: 'flex', height: 'calc(100vh - 70px)', overflow: 'hidden' }}>
        <div className="sidebar">
        <div className="sidebar-section">
          <h3>Navigation</h3>
          <div className="selector-group">
            {/* Instead of direct CustomDropdown usage, use the render methods */}
            {renderPatientDropdown()}
            
            {renderDicomDropdown()}
          </div>
        </div>
          
          <div className="sidebar-section">
            <h3>Labels</h3>
            <div className="label-buttons-vertical">
              {[1, 2, 3, 4, 5].map((num) => (
                <button
                  key={num}
                  className={getLabelClass(num)}
                  onClick={() => handleLabel(num.toString())}
                  disabled={buttonsDisabled || loadingImages}
                  data-label={num}
                >
                  {num}
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-section">
            <h3>Reset Options</h3>
            <div className="reset-buttons">
              <button 
                className="reset-button reset-labels"
                onClick={resetAllLabels}
                disabled={loading || apiStatus.loading || !patientsList || getTotalLabeledCount() === 0}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                  <path d="M3 3v5h5"></path>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                  <path d="M16 21h5v-5"></path>
                </svg>
                Reset All Labels
              </button>
              
              <button 
                className="reset-button start-over"
                onClick={startOver}
                disabled={loading || apiStatus.loading}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 2v6h6"></path>
                  <path d="M21 12A9 9 0 0 0 3.86 8.14L3 14"></path>
                  <path d="M21 22v-6h-6"></path>
                  <path d="M3 12a9 9 0 0 0 17.14 3.86L21 10"></path>
                </svg>
                Delete All DICOMS
              </button>
            </div>
          </div>
          
          <div className="sidebar-section keyboard-hint">
            <h3>Keyboard Shortcuts</h3>
            <ul>
              <li>Keys <kbd>1</kbd>-<kbd>5</kbd>: Label current DICOM</li>
              <li><kbd>Backspace</kbd>: Undo last label</li>
              <li><kbd>←</kbd>/<kbd>→</kbd>: Navigate through images</li>
              <li><kbd>Space</kbd>: Play/pause DICOM playback</li>
            </ul>
          </div>
        </div>
        
        <div className="content-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 70px)', overflow: 'hidden' }}>
          <div className="expanded-image-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
            <div className={`image-viewer ${overlay ? 'with-overlay' : ''}`} style={{
              display: 'flex', justifyContent: 'center', alignItems: 'center',
              height: 'calc(100vh - 210px)', backgroundColor: '#000', position: 'relative', overflow: 'hidden'
            }}>
              {loadingImages ? (
                <LoadingSpinner text="Processing Next Patients DICOM images..." />
              ) : currentImage ? (
                <img 
                  src={currentImage.src} 
                  alt={`${currentImage.id}`} 
                  className="dicom-image"
                  draggable="false"
                  style={{ height: '100%', maxWidth: '100%', objectFit: 'contain' }}
                />
              ) : (
                <div className="no-image-placeholder">
                  No image data available
                </div>
              )}
              
              <div className="image-metadata-overlay">
                <div className="metadata-item">
                  <span className="metadata-label">Patient:</span>
                  <span className="metadata-value">{currentPatient.patientName}</span>
                </div>
                <div className="metadata-item">
                  <span className="metadata-label">DICOM:</span>
                  <span className="metadata-value">{currentDicom.dicomName}</span>
                </div>
                {currentDicom.images && (
                  <div className="metadata-item">
                    <span className="metadata-label">Frame:</span>
                    <span className="metadata-value">{currentImageIndex + 1} of {currentDicom.images.length}</span>
                  </div>
                )}
                {!currentDicom.images && currentDicom.frameCount && (
                  <div className="metadata-item">
                    <span className="metadata-label">Frames:</span>
                    <span className="metadata-value">{currentDicom.frameCount} (processing data...)</span>
                  </div>
                )}
              </div>
              
              {overlay && (
                <div className="overlay">
                  <span className="overlay-text">{overlay}</span>
                </div>
              )}
              
              {showUndoOverlay && (
                <div className="undo-overlay">
                  <div className="undo-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7v6h6"></path>
                      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
                    </svg>
                  </div>
                </div>
              )}
              
              {isDicomLabeled(currentDicom) && (
                <div className="previous-label-indicator">
                  <span>Current label: {currentDicom.label}</span>
                </div>
              )}
            </div>
            
            {currentDicom.images && currentDicom.images.length > 0 ? (
              <DicomSlider 
                dicom={currentDicom} 
                currentImageIndex={currentImageIndex} 
                setCurrentImageIndex={setCurrentImageIndex} 
                buttonsDisabled={buttonsDisabled || loadingImages}
              />
            ) : (
              <div className="slider-empty">Loading frames or no images available</div>
            )}
          </div>
        </div>
      </div>
      
      {showCompletionModal && (
        <CompletionModal 
          count={getTotalLabeledCount()}
          onClose={() => {
            // Simply close the modal - don't change other state
            setShowCompletionModal(false);
          }}
          onExport={exportCSV}
          loading={apiStatus.loading}
        />
      )}
      
      {(apiStatus.loading || apiStatus.error) && (
        <div className="status-overlay">
          {apiStatus.loading && (
            <div className="status-message loading">
              Updating status...
            </div>
          )}
          {apiStatus.error && (
            <div className="status-message error">
              {apiStatus.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;