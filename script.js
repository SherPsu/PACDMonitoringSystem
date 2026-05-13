import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, query, orderBy, onSnapshot, serverTimestamp, limit } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

// Verify environment variables are loaded
if (!import.meta.env.VITE_FIREBASE_API_KEY) {
    throw new Error('Environment variables are not loaded. Make sure you:\n1. Have a .env file in the project root\n2. Restarted the Vite dev server after creating/modifying .env\n3. Are running through "npm run dev" (not opening HTML directly)');
}

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db  = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

let clientsChart = null;
let satisfactionChart = null;

class PACDMonitoringSystem {
    constructor() {
        this.records = [];
        this.currentUser = null;
        this._resetTargetUid = null;
        this.init();
    }

    async init() {
        this.setupLoginListeners();
        this.setupAuthState();
    }

    // ─────────────────────────────────────────
    //  AUTH
    // ─────────────────────────────────────────
    setupLoginListeners() {
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
    }

    setupAuthState() {
        onAuthStateChanged(auth, async (firebaseUser) => {
            if (firebaseUser) {
                const userSnap = await getDoc(doc(db, 'users', firebaseUser.uid));
                if (!userSnap.exists()) {
                    await signOut(auth);
                    this.showLoginError('Account not found. Contact administrator.');
                    return;
                }
                const userData = userSnap.data();
                if (userData.disabled) {
                    await signOut(auth);
                    this.showLoginError('Your account has been disabled. Contact administrator.');
                    return;
                }
                // Apply pending password set by admin
                if (userData.pendingPassword) {
                    try {
                        await updatePassword(firebaseUser, userData.pendingPassword);
                        await updateDoc(doc(db, 'users', firebaseUser.uid), { pendingPassword: null });
                    } catch (_) {}
                }
                this.currentUser = { uid: firebaseUser.uid, email: firebaseUser.email, ...userData };
                this.showApp();
                this.unlockDateForAdmin();
            } else {
                this.showLoginScreen();
            }
        });
    }

    async handleLogin(e) {
        e.preventDefault();
        const email    = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        const btn      = document.getElementById('loginBtn');
        btn.textContent = 'Signing in...';
        btn.disabled    = true;
        document.getElementById('loginError').textContent = '';
        try {
            const userCred = await signInWithEmailAndPassword(auth, email, password);
            const userSnap = await getDoc(doc(db, 'users', userCred.user.uid));
            if (userSnap.exists() && !userSnap.data().disabled) {
                // Log the login event
                await addDoc(collection(db, 'pacd_login_history'), {
                    uid: userCred.user.uid,
                    email: email,
                    name: userSnap.data().name || 'Unknown',
                    role: userSnap.data().role || 'officer',
                    timestamp: serverTimestamp()
                });
            }
        } catch (err) {
            let msg = 'Invalid email or password.';
            if (err.code === 'auth/too-many-requests') msg = 'Too many attempts. Try again later.';
            this.showLoginError(msg);
        } finally {
            btn.textContent = 'Sign In';
            btn.disabled    = false;
        }
    }

    async logout() {
        await signOut(auth);
    }

    showLoginScreen() {
        document.getElementById('loginScreen').style.display  = 'flex';
        document.getElementById('appContainer').style.display = 'none';
        document.getElementById('loginEmail').value    = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginError').textContent = '';
    }

    showApp() {
        document.getElementById('loginScreen').style.display  = 'none';
        document.getElementById('appContainer').style.display = 'block';
        // Show user info in header
        const headerUser = document.getElementById('headerUser');
        headerUser.style.display = 'flex';
        document.getElementById('headerUserName').textContent = this.currentUser.name || this.currentUser.email;
        const roleBadge = document.getElementById('headerUserRole');
        roleBadge.textContent = this.currentUser.role === 'admin' ? 'Admin' : 'Officer';
        roleBadge.className   = `user-role-badge role-${this.currentUser.role}`;
        document.getElementById('manageUsersBtn').style.display =
            this.currentUser.role === 'admin' ? 'inline-flex' : 'none';
        this.setupEventListeners();
        this.listenRecords();
        this.loadOfficerDropdowns();
        this.setDefaultDate();
        this.updateLastUpdated();
        this.startClock();

        // Hide admin-only buttons for officers
        const isAdmin = this.currentUser?.role === 'admin';
        ['viewRecentlyDeleted', 'viewHistory', 'backupData', 'restoreData'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = isAdmin ? 'inline-flex' : 'none';
        });
    }

    showLoginError(msg) {
        document.getElementById('loginError').textContent = msg;
    }

    setupEventListeners() {
        // Tab navigation
        document.querySelectorAll('.nav-tab').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.tab));
        });

        // Form submissions
        document.getElementById('dailyEntryForm').addEventListener('submit', (e) => this.handleFormSubmit(e));
        document.getElementById('editForm').addEventListener('submit', (e) => this.handleEditSubmit(e));

        // Form controls
        document.getElementById('clearForm').addEventListener('click', () => this.clearForm());
        document.getElementById('cancelEdit').addEventListener('click', () => this.closeEditModal());

        // Auto-calculation for daily entry form
        ['newMember', 'amendment', 'yakapAssignment', 'er2', 'inquiry', 'printIdMdr'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.calculateTotal());
        });

        // Auto-calculation for edit modal
        ['editNewMember', 'editAmendment', 'editYakapAssignment', 'editEr2', 'editInquiry', 'editPrintIdMdr'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.calculateEditTotal());
        });

        // Satisfaction survey validation
        ['yesCount', 'noCount'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => this.validateSatisfactionSurvey());
        });

        // Search and filter
        document.getElementById('searchInput').addEventListener('input', () => this.filterRecords());
        document.getElementById('filterDate').addEventListener('change', () => this.filterRecords());

        // Export and backup
        document.getElementById('exportCSV').addEventListener('click', () => this.exportToExcel());
        document.getElementById('exportWeeklySummary').addEventListener('click', () => this.openExportModal('week'));
        document.getElementById('exportMonthlySummary').addEventListener('click', () => this.openExportModal('month'));
        document.getElementById('exportCustomRange').addEventListener('click', () => this.openExportModal('custom'));
        document.getElementById('backupData').addEventListener('click', () => this.backupData());
        document.getElementById('restoreData').addEventListener('click', () => this.restoreData());

        // Dashboard PDF export
        document.getElementById('exportDashboardPDF').addEventListener('click', () => this.exportDashboardPDF());

        // History modal
        document.getElementById('viewHistory').addEventListener('click', () => this.openHistoryModal());
        document.getElementById('closeHistoryModal').addEventListener('click', () => this.closeHistoryModal());
        document.getElementById('historyModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('historyModal')) this.closeHistoryModal();
        });

        // Recently Deleted modal
        document.getElementById('viewRecentlyDeleted').addEventListener('click', () => this.openRecentlyDeletedModal());
        document.getElementById('closeRecentlyDeletedModal').addEventListener('click', () => this.closeRecentlyDeletedModal());
        document.getElementById('recentlyDeletedModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('recentlyDeletedModal')) this.closeRecentlyDeletedModal();
        });

        // Remarks modal
        document.getElementById('closeRemarksModal').addEventListener('click', () => this.closeRemarksModal());
        document.getElementById('remarksModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('remarksModal')) this.closeRemarksModal();
        });

        // Export summary modal
        document.getElementById('closeExportModal').addEventListener('click', () => this.closeExportModal());
        document.getElementById('closeExportModal2').addEventListener('click', () => this.closeExportModal());
        document.getElementById('confirmExportSummary').addEventListener('click', () => this.confirmExportSummary());
        document.getElementById('exportSummaryModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('exportSummaryModal')) this.closeExportModal();
        });

        // File input for restore
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileRestore(e));

        // Modal close
        document.querySelector('.modal-close').addEventListener('click', () => this.closeEditModal());
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.closeEditModal();
            }
        });

        // Auth
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());

        // Admin panel
        document.getElementById('manageUsersBtn').addEventListener('click', () => this.openAdminPanel());
        document.getElementById('closeAdminPanel').addEventListener('click', () => this.closeAdminPanel());
        document.getElementById('adminPanelModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('adminPanelModal')) this.closeAdminPanel();
        });
        document.getElementById('createOfficerBtn').addEventListener('click', () => this.createOfficer());

        // Reset password modal
        document.getElementById('closeResetPasswordModal').addEventListener('click', () => this.closeResetPasswordModal());
        document.getElementById('closeResetPasswordModal2').addEventListener('click', () => this.closeResetPasswordModal());
        document.getElementById('confirmResetPassword').addEventListener('click', () => this.confirmResetPassword());
        document.getElementById('resetPasswordModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('resetPasswordModal')) this.closeResetPasswordModal();
        });
    }

    confirmAction(title, message, onConfirm, confirmText = 'Confirm', confirmStyle = '') {
        const modal = document.getElementById('confirmActionModal');
        if (!modal) return;
        
        document.getElementById('confirmActionTitle').textContent = title;
        document.getElementById('confirmActionMessage').textContent = message;
        
        const actionBtn = document.getElementById('confirmActionBtn');
        actionBtn.textContent = confirmText;
        if (confirmStyle) {
            actionBtn.style.background = confirmStyle === 'danger' ? '#EF4444' : '#10B981';
            actionBtn.style.color = '#fff';
            actionBtn.style.border = 'none';
        } else {
            actionBtn.style = '';
            actionBtn.className = 'btn btn-primary';
        }
        
        modal.classList.add('active');
        
        // Clean up listeners by cloning
        const newActionBtn = actionBtn.cloneNode(true);
        actionBtn.parentNode.replaceChild(newActionBtn, actionBtn);
        
        const cancelBtn = document.getElementById('confirmCancelBtn');
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        
        const closeBtn = document.getElementById('closeConfirmModal');
        if (closeBtn) {
            const newCloseBtn = closeBtn.cloneNode(true);
            closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
            newCloseBtn.addEventListener('click', () => modal.classList.remove('active'));
        }
        
        newCancelBtn.addEventListener('click', () => modal.classList.remove('active'));
        newActionBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            if (onConfirm) onConfirm();
        });
    }

    // ─────────────────────────────────────────
    //  ADMIN PANEL
    // ─────────────────────────────────────────
    async openAdminPanel() {
        document.getElementById('adminPanelModal').classList.add('active');
        await this.loadOfficers();
        await this.loadLoginHistory();
    }

    closeAdminPanel() {
        document.getElementById('adminPanelModal').classList.remove('active');
        document.getElementById('newOfficerName').value     = '';
        document.getElementById('newOfficerEmail').value    = '';
        document.getElementById('newOfficerPassword').value = '';
    }

    async loadOfficers() {
        const listEl = document.getElementById('officersList');
        listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:16px;">Loading...</p>';
        try {
            const snap = await getDocs(query(collection(db, 'users'), orderBy('name')));
            if (snap.empty) {
                listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:16px;">No accounts found.</p>';
                return;
            }
            listEl.innerHTML = snap.docs.map(d => {
                const u = d.data();
                const isDisabled = u.disabled === true;
                return `
                <div class="officer-item">
                    <div class="officer-info">
                        <span class="officer-name">${u.name || u.email}</span>
                        <span class="officer-email">${u.email}</span>
                        <span class="officer-tag role-${u.role}">${u.role}</span>
                        ${isDisabled ? '<span class="officer-tag tag-disabled">Disabled</span>' : ''}
                    </div>
                    <div class="officer-actions">
                        <button class="btn btn-sm" onclick="app.openResetPassword('${d.id}',&quot;${(u.name||u.email).replace(/"/g,'&quot;')}&quot;,&quot;${u.email.replace(/"/g,'&quot;')}&quot;)">
                            Reset Password
                        </button>
                        ${u.role !== 'admin' ? `
                        <button class="btn btn-sm ${isDisabled ? 'btn-success' : 'btn-danger'}"
                            onclick="app.toggleOfficerStatus('${d.id}', ${isDisabled})">
                            ${isDisabled ? 'Enable' : 'Disable'}
                        </button>
                        <button class="btn btn-sm btn-delete"
                            onclick="app.deleteOfficer('${d.id}','${(u.name||u.email).replace(/'/g,'')}')">
                            Delete
                        </button>` : ''}
                    </div>
                </div>`;
            }).join('');
        } catch (err) {
            console.error('Load officers error:', err);
            listEl.innerHTML = '<p style="color:var(--error);text-align:center;padding:16px;">Error loading accounts.</p>';
        }
    }

    async loadLoginHistory() {
        const listEl = document.getElementById('loginHistoryList');
        if (!listEl) return;
        listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:16px;">Loading history...</p>';
        try {
            const snap = await getDocs(query(collection(db, 'pacd_login_history'), orderBy('timestamp', 'desc'), limit(50)));
            if (snap.empty) {
                listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:16px;">No login history found.</p>';
                return;
            }
            
            listEl.innerHTML = snap.docs.map(d => {
                const data = d.data();
                let time = 'Just now';
                if (data.timestamp) {
                    const dateObj = data.timestamp.toDate();
                    const dateOpts = { year: 'numeric', month: 'short', day: 'numeric' };
                    const timeOpts = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
                    time = `${dateObj.toLocaleDateString('en-US', dateOpts)} at ${dateObj.toLocaleTimeString('en-US', timeOpts)}`;
                }
                return `
                <div class="officer-item" style="flex-direction:column;align-items:flex-start;gap:4px;">
                    <div style="display:flex;justify-content:space-between;width:100%;">
                        <strong>${data.name}</strong>
                        <span style="color:var(--gray-500);font-size:0.85rem;">${time}</span>
                    </div>
                    <div style="color:var(--gray-500);font-size:0.85rem;">
                        ${data.email} &bull; <span style="text-transform:capitalize;">${data.role}</span>
                    </div>
                </div>
                `;
            }).join('');
        } catch (e) {
            console.error('loadLoginHistory error:', e);
            listEl.innerHTML = '<p style="color:var(--error);text-align:center;padding:16px;">Error loading login history.</p>';
        }
    }

    async createOfficer() {
        const name     = document.getElementById('newOfficerName').value.trim();
        const email    = document.getElementById('newOfficerEmail').value.trim();
        const password = document.getElementById('newOfficerPassword').value;
        const role     = document.getElementById('newOfficerRole').value || 'officer';

        if (!name || !email || !password) {
            this.showNotification('Please fill in all fields.', 'error'); return;
        }
        if (password.length < 6) {
            this.showNotification('Password must be at least 6 characters.', 'error'); return;
        }

        const btn = document.getElementById('createOfficerBtn');
        btn.textContent = 'Creating...';
        btn.disabled = true;

        try {
            // Create Firebase Auth user without logging out current admin
            const secondApp  = initializeApp(firebaseConfig, `sec-${Date.now()}`);
            const secondAuth = getAuth(secondApp);
            const { user }   = await createUserWithEmailAndPassword(secondAuth, email, password);
            await signOut(secondAuth);
            await deleteApp(secondApp);

            // Store user profile in Firestore
            await setDoc(doc(db, 'users', user.uid), {
                name,
                email,
                role,
                disabled:   false,
                created_at: serverTimestamp()
            });

            document.getElementById('newOfficerName').value     = '';
            document.getElementById('newOfficerEmail').value    = '';
            document.getElementById('newOfficerPassword').value = '';
            document.getElementById('newOfficerRole').value     = 'officer';
            this.showNotification(`Account created for ${name}.`, 'success');
            await this.loadOfficers();
            await this.loadOfficerDropdowns();
        } catch (err) {
            console.error('Create officer error:', err);
            const msg = err.code === 'auth/email-already-in-use'
                ? 'This email is already registered.'
                : 'Error creating account. Please try again.';
            this.showNotification(msg, 'error');
        } finally {
            btn.textContent = 'Create Account';
            btn.disabled = false;
        }
    }

    async loadOfficerDropdowns() {
        try {
            const snap = await getDocs(query(collection(db, 'users'), orderBy('name')));
            const names = snap.docs
                .map(d => d.data())
                .filter(u => !u.disabled && u.role === 'officer')
                .map(u => u.name || u.email);

            ['officerName', 'editOfficerName'].forEach(id => {
                const sel = document.getElementById(id);
                if (!sel) return;
                const current = sel.value;
                sel.innerHTML = '<option value="">Select Officer...</option>';
                names.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    sel.appendChild(opt);
                });
                if (current) sel.value = current;
            });

            // Auto-select and lock the dropdown for officers only
            if (this.currentUser?.role === 'officer') {
                const sel = document.getElementById('officerName');
                if (sel) {
                    sel.value = this.currentUser.name || this.currentUser.email;
                    sel.style.pointerEvents = 'none';
                    sel.style.opacity       = '0.7';
                    sel.style.cursor        = 'not-allowed';
                }
            } else {
                // For admins, ensure dropdown is not locked and is empty
                const sel = document.getElementById('officerName');
                if (sel) {
                    sel.style.pointerEvents = '';
                    sel.style.opacity       = '';
                    sel.style.cursor        = '';
                    sel.value = '';
                }
            }
        } catch (e) {
            console.error('loadOfficerDropdowns error:', e);
        }
    }

    async deleteOfficer(uid, name) {
        this.confirmAction(
            'Delete Account',
            `Delete account for "${name}"? This cannot be undone.`,
            async () => {
                try {
                    await deleteDoc(doc(db, 'users', uid));
                    this.showNotification(`Account for ${name} deleted.`, 'success');
                    await this.loadOfficers();
                    await this.loadOfficerDropdowns();
                } catch (err) {
                    console.error('Delete officer error:', err);
                    this.showNotification('Error deleting account.', 'error');
                }
            },
            'Delete',
            'danger'
        );
    }

    async toggleOfficerStatus(uid, currentlyDisabled) {
        try {
            await updateDoc(doc(db, 'users', uid), { disabled: !currentlyDisabled });
            this.showNotification(
                currentlyDisabled ? 'Account enabled.' : 'Account disabled.',
                'success'
            );
            await this.loadOfficers();
        } catch (err) {
            console.error('Toggle status error:', err);
            this.showNotification('Error updating account status.', 'error');
        }
    }

    openResetPassword(uid, name, email) {
        this._resetTargetUid = uid;
        this._resetTargetEmail = email;
        document.getElementById('resetPasswordFor').textContent = `Send password reset email to: ${name} (${email})`;
        document.getElementById('resetPasswordModal').classList.add('active');
    }

    closeResetPasswordModal() {
        document.getElementById('resetPasswordModal').classList.remove('active');
        this._resetTargetUid = null;
        this._resetTargetEmail = null;
    }

    async confirmResetPassword() {
        if (!this._resetTargetEmail) {
            this.showNotification('No email address found for this user.', 'error');
            return;
        }
        try {
            const { sendPasswordResetEmail } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
            await sendPasswordResetEmail(auth, this._resetTargetEmail);
            this.closeResetPasswordModal();
            this.showNotification(`Password reset email sent to ${this._resetTargetEmail}`, 'success');
        } catch (err) {
            console.error('Send reset email error:', err);
            this.showNotification('Error sending password reset email.', 'error');
        }
    }

    switchTab(tabName) {
        // Remove active class from all tabs and buttons
        document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(content => content.classList.remove('active'));
        
        // Add active class to clicked button and corresponding tab
        document.querySelector(`.nav-tab[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(tabName).classList.add('active');
        
        // Update dashboard if switching to dashboard tab
        if (tabName === 'dashboard') {
            this.updateDashboard();
        }
    }

    calculateTotal() {
        const newMember = parseInt(document.getElementById('newMember').value) || 0;
        const amendment = parseInt(document.getElementById('amendment').value) || 0;
        const yakapAssignment = parseInt(document.getElementById('yakapAssignment').value) || 0;
        const er2 = parseInt(document.getElementById('er2').value) || 0;
        const inquiry = parseInt(document.getElementById('inquiry').value) || 0;
        const printIdMdr = parseInt(document.getElementById('printIdMdr').value) || 0;

        const totalTransactions = newMember + amendment + yakapAssignment + er2 + inquiry + printIdMdr;
        document.getElementById('totalTransactions').value = totalTransactions;

        // Validate satisfaction survey when total changes
        this.validateSatisfactionSurvey();
    }

    calculateEditTotal() {
        const newMember = parseInt(document.getElementById('editNewMember').value) || 0;
        const amendment = parseInt(document.getElementById('editAmendment').value) || 0;
        const yakapAssignment = parseInt(document.getElementById('editYakapAssignment').value) || 0;
        const er2 = parseInt(document.getElementById('editEr2').value) || 0;
        const inquiry = parseInt(document.getElementById('editInquiry').value) || 0;
        const printIdMdr = parseInt(document.getElementById('editPrintIdMdr').value) || 0;

        const totalTransactions = newMember + amendment + yakapAssignment + er2 + inquiry + printIdMdr;
        document.getElementById('editTotalTransactions').value = totalTransactions;
    }

    validateSatisfactionSurvey() {
        const totalClients = parseInt(document.getElementById('totalClients').value) || 0;
        const yesCount = parseInt(document.getElementById('yesCount').value) || 0;
        const noCount = parseInt(document.getElementById('noCount').value) || 0;
        const satisfactionTotal = yesCount + noCount;
        
        const yesInput = document.getElementById('yesCount');
        const noInput = document.getElementById('noCount');
        
        // Check if elements exist before trying to validate
        if (!yesInput || !noInput || !document.getElementById('totalClients')) {
            return true; // Skip validation if elements don't exist
        }
        
        // Clear previous validation states
        yesInput.style.borderColor = '';
        noInput.style.borderColor = '';
        
        // Remove existing error message if any
        const existingError = document.getElementById('satisfaction-error');
        if (existingError) {
            existingError.remove();
        }
        
        if (satisfactionTotal > totalClients && totalClients > 0) {
            yesInput.style.borderColor = '#EF4444';
            noInput.style.borderColor = '#EF4444';
            this.showNotification(`Survey responses (${satisfactionTotal}) cannot exceed total clients served (${totalClients})`, 'error');
            return false;
        }
        
        return true;
    }

    async handleFormSubmit(e) {
        e.preventDefault();
        
        const dateField = document.getElementById('date');
        this.setDefaultDate();
        
        if (!this.validateSatisfactionSurvey()) {
            this.showNotification('Please fix the validation errors before submitting.', 'error');
            return;
        }
        
        const officerName = document.getElementById('officerName').value;
        if (!officerName) {
            this.showNotification('Please select an officer name.', 'error');
            return;
        }
        
        const formData = {
            date: dateField.value,
            officer_name: officerName,
            new_member: parseInt(document.getElementById('newMember').value) || 0,
            amendment: parseInt(document.getElementById('amendment').value) || 0,
            yakap_assignment: parseInt(document.getElementById('yakapAssignment').value) || 0,
            er2: parseInt(document.getElementById('er2').value) || 0,
            inquiry: parseInt(document.getElementById('inquiry').value) || 0,
            print_id_mdr: parseInt(document.getElementById('printIdMdr').value) || 0,
            total_transactions: parseInt(document.getElementById('totalTransactions').value) || 0,
            total_clients: parseInt(document.getElementById('totalClients').value) || 0,
            yes_count: parseInt(document.getElementById('yesCount').value) || 0,
            no_count: parseInt(document.getElementById('noCount').value) || 0,
            remarks: document.getElementById('remarks').value || '',
            created_at: new Date().toISOString(),
            created_by_uid: this.currentUser?.uid || null
        };
        
        try {
            const docRef = await addDoc(collection(db, 'pacd_records'), formData);
            await this.logActivity('added', docRef.id, formData.officer_name, formData.date);
            this.clearForm();
            this.showNotification('Record saved successfully!', 'success');
        } catch (error) {
            console.error('Form submission error:', error);
            this.showNotification('Error saving record. Please try again.', 'error');
        }
    }

    clearForm() {
        document.getElementById('dailyEntryForm').reset();
        document.getElementById('totalClients').value = '0';
        this.setDefaultDate();
        
        // Clear validation styling and error messages
        const yesInput = document.getElementById('yesCount');
        const noInput = document.getElementById('noCount');
        if (yesInput) yesInput.style.borderColor = '';
        if (noInput) noInput.style.borderColor = '';
        
        const existingError = document.getElementById('satisfaction-error');
        if (existingError) {
            existingError.remove();
        }
    }

    setDefaultDate() {
        const today = new Date().toISOString().split('T')[0];
        const dateField = document.getElementById('date');
        if (dateField) dateField.value = today;
    }

    unlockDateForAdmin() {
        const isAdmin = this.currentUser?.role === 'admin';
        const dateField = document.getElementById('date');
        const editDateField = document.getElementById('editDate');
        if (isAdmin) {
            if (dateField) dateField.removeAttribute('readonly');
            if (editDateField) editDateField.removeAttribute('readonly');
        } else {
            if (dateField) dateField.setAttribute('readonly', true);
            if (editDateField) editDateField.setAttribute('readonly', true);
        }
    }

    togglePassword(fieldId) {
        const input = document.getElementById(fieldId);
        const button = input.nextElementSibling;
        if (!input || !button) return;

        if (input.type === 'password') {
            input.type = 'text';
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/></svg>';
        } else {
            input.type = 'password';
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        }
    }

    listenRecords() {
        const q = query(collection(db, 'pacd_records'), orderBy('date', 'desc'));
        onSnapshot(q, (snapshot) => {
            let fetchedRecords = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            
            // Sort by date desc, then created_at desc to keep newest entries on top
            fetchedRecords.sort((a, b) => {
                if (a.date !== b.date) {
                    return (b.date || '').localeCompare(a.date || '');
                }
                const timeA = a.created_at || '';
                const timeB = b.created_at || '';
                return timeB.localeCompare(timeA);
            });
            
            this.records = fetchedRecords;
            this.filterRecords(); // Call filterRecords instead of displayRecords directly
            this.updateStats(this.records);
            this.updateCharts(this.records);
            this.updateLastUpdated();
        }, (error) => {
            console.error('Firestore listen error:', error);
            this.showNotification('Error loading records.', 'error');
        });
    }

    loadRecords() {
        this.filterRecords();
    }

    displayRecords(records) {
        const tbody = document.getElementById('recordsTableBody');
        
        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No records found. Start by adding a new record!</td></tr>';
            return;
        }

        tbody.innerHTML = records.map(record => {
            const others = (record.inquiry || 0) + (record.print_id_mdr || 0);
            
            // Check if user has permission to edit/delete
            const canEdit = this.currentUser?.role === 'admin' || 
                           record.created_by_uid === this.currentUser?.uid ||
                           record.officer_name === (this.currentUser?.name || this.currentUser?.email);

            return `
            <tr>
                <td>${record.id}</td>
                <td>${record.date}</td>
                <td>${record.officer_name}</td>
                <td>${record.new_member}</td>
                <td>${record.amendment}</td>
                <td>${record.yakap_assignment}</td>
                <td>${record.er2}</td>
                <td>${others}</td>
                <td>${record.total_transactions || 0}</td>
                <td><strong>${record.total_clients}</strong></td>
                <td>${record.yes_count}</td>
                <td>${record.no_count}</td>
                <td>
                    <button class="btn-action btn-remarks" onclick="app.showRemarks('${record.id}')" title="View Remarks">💬</button>
                </td>
                <td>
                    <div class="action-buttons">
                        ${canEdit ? `
                        <button class="btn-action btn-edit" onclick="app.editRecord('${record.id}')" title="Edit">&#9998;</button>
                        <button class="btn-action btn-delete" onclick="app.deleteRecord('${record.id}')" title="Delete">&#128465;</button>
                        ` : '<span style="color:var(--gray-400);font-size:0.8rem;">Locked</span>'}
                    </div>
                </td>
            </tr>
        `;
        }).join('');
    }

    editRecord(firestoreId) {
        const record = this.records.find(r => r.id === firestoreId);
        if (!record) return;

        // Security check
        const canEdit = this.currentUser?.role === 'admin' || 
                       record.created_by_uid === this.currentUser?.uid ||
                       record.officer_name === (this.currentUser?.name || this.currentUser?.email);
        
        if (!canEdit) {
            this.showNotification('You do not have permission to edit this record.', 'error');
            return;
        }

        document.getElementById('editId').value = firestoreId;
        document.getElementById('editDate').value = record.date;
        const editOfficerSel = document.getElementById('editOfficerName');
        editOfficerSel.value = record.officer_name;
        if (this.currentUser?.role === 'officer') {
            editOfficerSel.style.pointerEvents = 'none';
            editOfficerSel.style.opacity       = '0.7';
            editOfficerSel.style.cursor        = 'not-allowed';
        } else {
            editOfficerSel.style.pointerEvents = '';
            editOfficerSel.style.opacity       = '';
            editOfficerSel.style.cursor        = '';
        }
        document.getElementById('editNewMember').value = record.new_member;
        document.getElementById('editAmendment').value = record.amendment;
        document.getElementById('editYakapAssignment').value = record.yakap_assignment;
        document.getElementById('editEr2').value = record.er2;
        document.getElementById('editInquiry').value = record.inquiry || 0;
        document.getElementById('editPrintIdMdr').value = record.print_id_mdr || 0;
        document.getElementById('editTotalTransactions').value = record.total_transactions || 0;
        document.getElementById('editTotalClients').value = record.total_clients;
        document.getElementById('editYesCount').value = record.yes_count;
        document.getElementById('editNoCount').value = record.no_count;
        document.getElementById('editRemarks').value = record.remarks || '';
        document.getElementById('editModal').classList.add('active');
    }

    async handleEditSubmit(e) {
        e.preventDefault();

        const firestoreId = document.getElementById('editId').value;
        const totalTransactions = (parseInt(document.getElementById('editNewMember').value) || 0) +
                     (parseInt(document.getElementById('editAmendment').value) || 0) +
                     (parseInt(document.getElementById('editYakapAssignment').value) || 0) +
                     (parseInt(document.getElementById('editEr2').value) || 0) +
                     (parseInt(document.getElementById('editInquiry').value) || 0) +
                     (parseInt(document.getElementById('editPrintIdMdr').value) || 0);

        const totalClients = parseInt(document.getElementById('editTotalClients').value) || 0;
        const yesCount = parseInt(document.getElementById('editYesCount').value) || 0;
        const noCount  = parseInt(document.getElementById('editNoCount').value) || 0;

        if ((yesCount + noCount) > totalClients && totalClients > 0) {
            this.showNotification(`Survey responses cannot exceed total clients served (${totalClients})`, 'error');
            return;
        }

        const editedDate = document.getElementById('editDate').value;
        const editedOfficer = document.getElementById('editOfficerName').value;
        try {
            await updateDoc(doc(db, 'pacd_records', firestoreId), {
                date:             editedDate,
                officer_name:     editedOfficer,
                new_member:       parseInt(document.getElementById('editNewMember').value) || 0,
                amendment:        parseInt(document.getElementById('editAmendment').value) || 0,
                yakap_assignment: parseInt(document.getElementById('editYakapAssignment').value) || 0,
                er2:              parseInt(document.getElementById('editEr2').value) || 0,
                inquiry:          parseInt(document.getElementById('editInquiry').value) || 0,
                print_id_mdr:     parseInt(document.getElementById('editPrintIdMdr').value) || 0,
                total_transactions: totalTransactions,
                total_clients:    totalClients,
                yes_count:        yesCount,
                no_count:         noCount,
                remarks:          document.getElementById('editRemarks').value || ''
            });
            await this.logActivity('edited', firestoreId, editedOfficer, editedDate);
            this.closeEditModal();
            this.showNotification('Record updated successfully!', 'success');
        } catch (error) {
            console.error('Edit submission error:', error);
            this.showNotification('Error updating record. Please try again.', 'error');
        }
    }

    async deleteRecord(firestoreId) {
        const record = this.records.find(r => r.id === firestoreId);
        if (!record) {
            this.showNotification('Record not found.', 'error');
            return;
        }

        // Security check
        const canDelete = this.currentUser?.role === 'admin' || 
                         record.created_by_uid === this.currentUser?.uid ||
                         record.officer_name === (this.currentUser?.name || this.currentUser?.email);
        
        if (!canDelete) {
            this.showNotification('You do not have permission to delete this record.', 'error');
            return;
        }

        this.confirmAction(
            'Delete Record',
            'Are you sure you want to delete this record? It will be moved to Recently Deleted and can be restored within 30 days.',
            async () => {
                try {
                    // Move to deleted collection with timestamp
                    const { id, ...recordData } = record;
                    const deletedRecord = {
                        ...recordData,
                        original_id: firestoreId,
                        deleted_at: new Date().toISOString(),
                        deleted_by: this.currentUser?.email || 'Unknown',
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
                    };
                    await addDoc(collection(db, 'pacd_deleted_records'), deletedRecord);
                    // Delete from main collection
                    await deleteDoc(doc(db, 'pacd_records', firestoreId));
                    await this.logActivity('deleted', firestoreId, record?.officer_name || 'Unknown', record?.date || '');
                    this.showNotification('Record moved to Recently Deleted. You can restore it within 30 days.', 'success');
                } catch (error) {
                    console.error('Delete record error:', error);
                    this.showNotification('Error deleting record. Please try again.', 'error');
                }
            },
            'Delete',
            'danger'
        );
    }

    showRemarks(firestoreId) {
        const record = this.records.find(r => r.id === firestoreId);
        if (!record) return;

        const remarksModal = document.getElementById('remarksModal');
        document.getElementById('remarksDate').textContent = record.date;
        document.getElementById('remarksOfficer').textContent = record.officer_name;
        document.getElementById('remarksContent').textContent = record.remarks || 'No remarks';
        
        remarksModal.classList.add('active');
    }

    async openRecentlyDeletedModal() {
        document.getElementById('recentlyDeletedModal').classList.add('active');
        await this.loadRecentlyDeleted();
    }

    closeRecentlyDeletedModal() {
        document.getElementById('recentlyDeletedModal').classList.remove('active');
    }

    closeRemarksModal() {
        document.getElementById('remarksModal').classList.remove('active');
    }

    async loadRecentlyDeleted() {
        const listEl = document.getElementById('recentlyDeletedList');
        listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:24px 0;">Loading...</p>';
        try {
            const snap = await getDocs(query(collection(db, 'pacd_deleted_records'), orderBy('deleted_at', 'desc')));
            if (snap.empty) {
                listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:24px 0;">No recently deleted records.</p>';
                return;
            }
            const now = new Date();
            listEl.innerHTML = snap.docs.map(d => {
                const r = d.data();
                const deletedDate = new Date(r.deleted_at);
                const daysLeft = Math.ceil((new Date(r.expires_at) - now) / (1000 * 60 * 60 * 24));
                return `
                <div class="officer-item" style="flex-direction:column;align-items:flex-start;gap:8px;">
                    <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                        <div>
                            <strong>${r.date}</strong> - ${r.officer_name || 'Unknown'}<br>
                            <small style="color:var(--gray-500);">
                                Trans: ${r.total_transactions || 0} | Clients: ${r.total_clients || 0} | 
                                Deleted: ${deletedDate.toLocaleString()} by ${r.deleted_by}
                            </small><br>
                            <small style="color:${daysLeft <= 3 ? 'var(--error)' : 'var(--warning)'};font-weight:600;">
                                ⏳ Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}
                            </small>
                        </div>
                        <div style="display:flex;gap:8px;">
                            <button class="btn btn-sm btn-success" onclick="app.restoreRecord('${d.id}')">
                                Restore
                            </button>
                            <button class="btn btn-sm" style="background:#EF4444;color:white;border:none;" onclick="app.permanentlyDeleteRecord('${d.id}')">
                                Permanent Delete
                            </button>
                        </div>
                    </div>
                </div>
                `;
            }).join('');
        } catch (e) {
            console.error('Load recently deleted error:', e);
            listEl.innerHTML = '<p style="color:var(--error);text-align:center;padding:24px 0;">Error loading recently deleted records.</p>';
        }
    }

    async restoreRecord(deletedDocId) {
        this.confirmAction(
            'Restore Record',
            'Are you sure you want to restore this record?',
            async () => {
                try {
                    const deletedDoc = await getDoc(doc(db, 'pacd_deleted_records', deletedDocId));
                    if (!deletedDoc.exists()) {
                        this.showNotification('Record not found in recently deleted.', 'error');
                        return;
                    }
                    const data = deletedDoc.data();

                    // Security check
                    const canRestore = this.currentUser?.role === 'admin' || 
                                      data.created_by_uid === this.currentUser?.uid ||
                                      data.officer_name === (this.currentUser?.name || this.currentUser?.email);
                    
                    if (!canRestore) {
                        this.showNotification('You do not have permission to restore this record.', 'error');
                        return;
                    }

                    // Remove system fields before restoring
                    const { original_id, deleted_at, deleted_by, expires_at, id, ...restoredData } = data;
                    
                    if (original_id) {
                        // Restore to main collection with original ID
                        await setDoc(doc(db, 'pacd_records', original_id), restoredData);
                    } else {
                        // Fallback for older deleted records
                        await addDoc(collection(db, 'pacd_records'), restoredData);
                    }
                    
                    // Delete from deleted collection
                    await deleteDoc(doc(db, 'pacd_deleted_records', deletedDocId));
                    
                    await this.logActivity('restored', original_id || 'unknown', restoredData.officer_name || 'Unknown', restoredData.date || '');
                    this.showNotification('Record restored successfully!', 'success');
                    await this.loadRecentlyDeleted();
                } catch (e) {
                    console.error('Restore record error:', e);
                    this.showNotification('Error restoring record.', 'error');
                }
            },
            'Restore',
            'success'
        );
    }

    async permanentlyDeleteRecord(deletedDocId) {
        // Only admin can permanently delete from recently deleted
        if (this.currentUser?.role !== 'admin') {
            this.showNotification('Only administrators can permanently delete records.', 'error');
            return;
        }

        this.confirmAction(
            'Permanent Delete',
            'Are you sure you want to permanently delete this record? This action cannot be undone.',
            async () => {
                try {
                    await deleteDoc(doc(db, 'pacd_deleted_records', deletedDocId));
                    this.showNotification('Record permanently deleted.', 'success');
                    await this.loadRecentlyDeleted();
                } catch (error) {
                    console.error('Permanent delete error:', error);
                    this.showNotification('Error permanently deleting record.', 'error');
                }
            },
            'Delete',
            'danger'
        );
    }

    async logActivity(action, recordId, officerName, date) {
        try {
            await addDoc(collection(db, 'pacd_activity_log'), {
                action,
                record_id:    recordId,
                officer_name: officerName,
                record_date:  date,
                timestamp:    serverTimestamp()
            });
        } catch (e) {
            console.error('Log activity error:', e);
        }
    }

    async openHistoryModal() {
        document.getElementById('historyModal').classList.add('active');
        const listEl = document.getElementById('historyList');
        listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:24px 0;">Loading...</p>';

        try {
            const q = query(collection(db, 'pacd_activity_log'), orderBy('timestamp', 'desc'), limit(100));
            const snapshot = await getDocs(q);

            if (snapshot.empty) {
                listEl.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:24px 0;">No activity recorded yet.</p>';
                return;
            }

            const actionMeta = {
                added:   { label: 'Added',   color: '#10B981', bg: '#D1FAE5' },
                edited:  { label: 'Edited',  color: '#3B82F6', bg: '#DBEAFE' },
                deleted: { label: 'Deleted', color: '#EF4444', bg: '#FEE2E2' }
            };

            listEl.innerHTML = snapshot.docs.map(d => {
                const log = d.data();
                const m = actionMeta[log.action] || actionMeta.edited;
                const ts = log.timestamp?.toDate();
                const timeStr = ts ? ts.toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Just now';
                return `
                    <div class="history-item">
                        <div class="history-badge" style="background:${m.bg};color:${m.color};">${m.label}</div>
                        <div class="history-details">
                            <span class="history-officer">${log.officer_name}</span>
                            <span class="history-meta">Record date: ${log.record_date}</span>
                        </div>
                        <div class="history-time">${timeStr}</div>
                    </div>`;
            }).join('');
        } catch (error) {
            console.error('Load history error:', error);
            listEl.innerHTML = '<p style="color:var(--error);text-align:center;padding:24px 0;">Error loading history.</p>';
        }
    }

    closeHistoryModal() {
        document.getElementById('historyModal').classList.remove('active');
    }

    closeEditModal() {
        document.getElementById('editModal').classList.remove('active');
    }

    filterRecords() {
        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
        const filterDate = document.getElementById('filterDate').value;
        
        let filtered = this.records;
        if (searchTerm) {
            filtered = filtered.filter(r =>
                r.officer_name.toLowerCase().includes(searchTerm) ||
                r.date.includes(searchTerm)
            );
        }
        if (filterDate) {
            filtered = filtered.filter(r => r.date === filterDate);
        }
        
        // Explicitly sort the filtered results to ensure recent data is always on top
        filtered.sort((a, b) => {
            if (a.date !== b.date) {
                return (b.date || '').localeCompare(a.date || '');
            }
            const timeA = a.created_at || '';
            const timeB = b.created_at || '';
            return timeB.localeCompare(timeA);
        });
        
        this.displayRecords(filtered);
    }

    updateDashboard() {
        this.updateStats(this.records);
        this.updateCharts(this.records);
    }

    updateStats(records) {
        const totalRecords = records.length;
        const totalClients = records.reduce((sum, record) => sum + record.total_clients, 0);
        const totalYes = records.reduce((sum, record) => sum + record.yes_count, 0);
        const totalNo = records.reduce((sum, record) => sum + record.no_count, 0);
        const totalResponses = totalYes + totalNo;
        const satisfactionRate = totalClients > 0 ? ((totalYes / totalClients) * 100).toFixed(1) : 0;
        const avgDailyClients = totalRecords > 0 ? Math.round(totalClients / totalRecords) : 0;
        
        document.getElementById('totalRecords').textContent = totalRecords;
        document.getElementById('totalClientsServed').textContent = totalClients.toLocaleString();
        document.getElementById('satisfactionRate').textContent = `${satisfactionRate}%`;
        document.getElementById('avgDailyClients').textContent = avgDailyClients;
    }

    updateCharts(records) {
        if (records.length === 0) return;
        
        // Sort records by date for charts
        const sortedRecords = records.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        const labels = sortedRecords.map(record => record.date);
        const clientsData = sortedRecords.map(record => record.total_clients);
        
        const totalYes = records.reduce((sum, r) => sum + r.yes_count, 0);
        const totalNo = records.reduce((sum, r) => sum + r.no_count, 0);

        const commonTooltip = {
            backgroundColor: '#1F2937',
            titleColor: '#F9FAFB',
            bodyColor: '#D1FAE5',
            borderColor: '#00875A',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            titleFont: { size: 13, weight: '600' },
            bodyFont: { size: 12 }
        };

        // ── Clients Trend Chart (smooth gradient area) ──
        const clientsCtx = document.getElementById('clientsChart').getContext('2d');
        if (clientsChart) clientsChart.destroy();

        const gradient = clientsCtx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(0, 135, 90, 0.35)');
        gradient.addColorStop(1, 'rgba(0, 135, 90, 0.00)');

        clientsChart = new Chart(clientsCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Clients Served',
                    data: clientsData,
                    borderColor: '#00875A',
                    backgroundColor: gradient,
                    tension: 0.45,
                    fill: true,
                    borderWidth: 3,
                    pointBackgroundColor: '#00875A',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    pointHoverBackgroundColor: '#006B48',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: commonTooltip
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
                        ticks: {
                            color: '#6B7280',
                            font: { size: 11 },
                            padding: 8,
                            stepSize: 1
                        },
                        border: { display: false }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#6B7280', font: { size: 11 }, maxRotation: 0 },
                        border: { display: false }
                    }
                }
            }
        });

        // ── Customer Satisfaction Chart (doughnut) ──
        const satisfactionCtx = document.getElementById('satisfactionChart').getContext('2d');
        if (satisfactionChart) satisfactionChart.destroy();

        satisfactionChart = new Chart(satisfactionCtx, {
            type: 'doughnut',
            data: {
                labels: ['Answered Survey', 'Did Not Answer'],
                datasets: [{
                    data: [totalYes, totalNo],
                    backgroundColor: ['#00875A', '#EF4444'],
                    hoverBackgroundColor: ['#006B48', '#DC2626'],
                    borderColor: '#fff',
                    borderWidth: 3,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            color: '#374151',
                            font: { size: 12, weight: '500' },
                            padding: 20,
                            usePointStyle: true,
                            pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        ...commonTooltip,
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.label}: ${ctx.parsed} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    exportToExcel() {
        try {
            const records = this.records;

            if (records.length === 0) {
                this.showNotification('No records to export.', 'warning');
                return;
            }

            // Build rows with friendly headers
            const rows = records.map(r => ({
                'ID':                 r.id,
                'Date':               r.date,
                'Officer Name':       r.officer_name,
                'New Member':         r.new_member,
                'Amendment':          r.amendment,
                'Yakap Assignment':   r.yakap_assignment,
                'ER2':                r.er2,
                'Inquiry':            r.inquiry || 0,
                'Print ID/MDR':       r.print_id_mdr || 0,
                'Transactions':       r.total_transactions || 0,
                'Clients':            r.total_clients,
                'Answered Survey':    r.yes_count,
                'Did Not Answer':     r.no_count
            }));

            const worksheet = XLSX.utils.json_to_sheet(rows);

            // Set column widths
            worksheet['!cols'] = [
                { wch: 6  },   // ID
                { wch: 12 },   // Date
                { wch: 30 },   // Officer Name
                { wch: 12 },   // New Member
                { wch: 12 },   // Amendment
                { wch: 18 },   // Yakap Assignment
                { wch: 8  },   // ER2
                { wch: 10 },   // Inquiry
                { wch: 12 },   // Print ID/MDR
                { wch: 12 },   // Transactions
                { wch: 10 },   // Clients
                { wch: 10 },   // Yes Count
                { wch: 10 }    // No Count
            ];

            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'PACD Records');

            const filename = `pacd_records_${new Date().toISOString().split('T')[0]}.xlsx`;
            XLSX.writeFile(workbook, filename);

            this.showNotification('Data exported to Excel successfully!', 'success');
        } catch (error) {
            console.error('Excel export error:', error);
            this.showNotification('Error exporting data to Excel.', 'error');
        }
    }

    async exportDashboardPDF() {
        const btn = document.getElementById('exportDashboardPDF');
        const originalText = btn.innerHTML;
        btn.innerHTML = 'Generating...';
        btn.disabled = true;

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            const pageW = pdf.internal.pageSize.getWidth();
            const pageH = pdf.internal.pageSize.getHeight();
            const margin = 12;

            // ── Header ──
            pdf.setFillColor(0, 135, 90);
            pdf.rect(0, 0, pageW, 22, 'F');
            pdf.setTextColor(255, 255, 255);
            pdf.setFontSize(14);
            pdf.setFont('helvetica', 'bold');
            pdf.text('PACD Monitoring System — Dashboard Report', margin, 14);
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'normal');
            pdf.text(`Generated: ${new Date().toLocaleString()}`, pageW - margin, 14, { align: 'right' });

            // ── Stats summary ──
            pdf.setTextColor(30, 41, 59);
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'bold');
            pdf.text('Summary Statistics', margin, 32);

            const stats = [
                ['Total Records',        document.getElementById('totalRecords').textContent],
                ['Total Clients Served', document.getElementById('totalClientsServed').textContent],
                ['Satisfaction Rate',    document.getElementById('satisfactionRate').textContent],
                ['Avg Daily Clients',    document.getElementById('avgDailyClients').textContent]
            ];

            const cellW = (pageW - margin * 2) / 4;
            stats.forEach(([label, value], i) => {
                const x = margin + i * cellW;
                pdf.setFillColor(241, 248, 241);
                pdf.roundedRect(x, 35, cellW - 2, 18, 2, 2, 'F');
                pdf.setFontSize(7);
                pdf.setFont('helvetica', 'normal');
                pdf.setTextColor(100, 116, 139);
                pdf.text(label, x + (cellW - 2) / 2, 41, { align: 'center' });
                pdf.setFontSize(12);
                pdf.setFont('helvetica', 'bold');
                pdf.setTextColor(0, 135, 90);
                pdf.text(value, x + (cellW - 2) / 2, 49, { align: 'center' });
            });

            // ── Charts ──
            pdf.setTextColor(30, 41, 59);
            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'bold');
            pdf.text('Charts', margin, 63);

            const chartIds = ['clientsChart', 'satisfactionChart'];
            const chartTitles = ['Clients Served Trend', 'Customer Satisfaction'];
            const chartW = (pageW - margin * 2 - 6) / 2;
            const chartH = chartW * 0.65;

            for (let i = 0; i < chartIds.length; i++) {
                const canvas = document.getElementById(chartIds[i]);
                const imgData = canvas.toDataURL('image/png', 1.0);
                const x = margin + i * (chartW + 6);
                const y = 66;
                pdf.setFillColor(255, 255, 255);
                pdf.setDrawColor(226, 232, 240);
                pdf.roundedRect(x, y, chartW, chartH + 8, 2, 2, 'FD');
                pdf.setFontSize(8);
                pdf.setFont('helvetica', 'bold');
                pdf.setTextColor(51, 65, 85);
                pdf.text(chartTitles[i], x + chartW / 2, y + 6, { align: 'center' });
                pdf.addImage(imgData, 'PNG', x + 2, y + 8, chartW - 4, chartH - 2);
            }

            const filename = `pacd_dashboard_${new Date().toISOString().split('T')[0]}.pdf`;
            pdf.save(filename);
            this.showNotification('Dashboard exported as PDF!', 'success');
        } catch (error) {
            console.error('PDF export error:', error);
            this.showNotification('Error exporting dashboard.', 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    openExportModal(type) {
        this._exportModalType = type;
        const now = new Date();

        if (type === 'week') {
            document.getElementById('exportSummaryTitle').textContent = 'Export Weekly Summary';
            document.getElementById('weekPickerGroup').style.display = 'block';
            document.getElementById('monthPickerGroup').style.display = 'none';
            document.getElementById('customRangeGroup').style.display = 'none';
            // Default to current week (YYYY-Www format)
            const year = now.getFullYear();
            const startOfYear = new Date(year, 0, 1);
            const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
            document.getElementById('weekPicker').value = `${year}-W${String(weekNum).padStart(2, '0')}`;
        } else if (type === 'month') {
            document.getElementById('exportSummaryTitle').textContent = 'Export Monthly Summary';
            document.getElementById('monthPickerGroup').style.display = 'block';
            document.getElementById('weekPickerGroup').style.display = 'none';
            document.getElementById('customRangeGroup').style.display = 'none';
            const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            document.getElementById('monthPicker').value = ym;
        } else if (type === 'custom') {
            document.getElementById('exportSummaryTitle').textContent = 'Export Custom Range';
            document.getElementById('customRangeGroup').style.display = 'block';
            document.getElementById('weekPickerGroup').style.display = 'none';
            document.getElementById('monthPickerGroup').style.display = 'none';
            const today = now.toISOString().split('T')[0];
            document.getElementById('customFromDate').value = today;
            document.getElementById('customToDate').value = today;
        }

        document.getElementById('exportSummaryModal').classList.add('active');
    }

    closeExportModal() {
        document.getElementById('exportSummaryModal').classList.remove('active');
    }

    confirmExportSummary() {
        if (this._exportModalType === 'week') {
            const val = document.getElementById('weekPicker').value; // e.g. "2026-W19"
            if (!val) { this.showNotification('Please select a week.', 'error'); return; }

            // Parse YYYY-Www → Monday date
            const [yearStr, weekStr] = val.split('-W');
            const year = parseInt(yearStr);
            const week = parseInt(weekStr);
            const jan4 = new Date(year, 0, 4); // Jan 4 is always in week 1
            const monday = new Date(jan4);
            monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
            const friday = new Date(monday);
            friday.setDate(monday.getDate() + 4); // Friday is Monday + 4 days

            const fmt = d => d.toISOString().split('T')[0];
            const weekStart = fmt(monday);
            const weekEnd   = fmt(friday);

            // Filter records for Monday-Friday only (exclude Saturday=6 and Sunday=0)
            const filtered = this.records.filter(r => {
                if (r.date < weekStart || r.date > weekEnd) return false;
                const dayOfWeek = new Date(r.date).getDay();
                return dayOfWeek !== 0 && dayOfWeek !== 6; // Exclude Sunday (0) and Saturday (6)
            });
            if (filtered.length === 0) {
                this.showNotification(`No records found for ${weekStart} to ${weekEnd} (Mon-Fri).`, 'warning');
                return;
            }
            this.closeExportModal();
            this._exportSummarySheet(filtered, `Weekly Summary: ${weekStart} to ${weekEnd} (Mon-Fri)`, `pacd_weekly_${weekStart}_${weekEnd}_monfri.xlsx`);

        } else if (this._exportModalType === 'month') {
            const val = document.getElementById('monthPicker').value; // e.g. "2026-05"
            if (!val) { this.showNotification('Please select a month.', 'error'); return; }

            const [year, month] = val.split('-');
            const monthStart = `${year}-${month}-01`;
            const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
            const monthEnd = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

            const filtered = this.records.filter(r => r.date >= monthStart && r.date <= monthEnd);
            if (filtered.length === 0) {
                this.showNotification(`No records found for ${val}.`, 'warning');
                return;
            }
            const monthLabel = new Date(`${year}-${month}-01`).toLocaleString('default', { month: 'long', year: 'numeric' });
            this.closeExportModal();
            this._exportSummarySheet(filtered, `Monthly Summary: ${monthLabel}`, `pacd_monthly_${val}.xlsx`);
        } else if (this._exportModalType === 'custom') {
            const fromDate = document.getElementById('customFromDate').value;
            const toDate = document.getElementById('customToDate').value;

            if (!fromDate || !toDate) {
                this.showNotification('Please select both From and To dates.', 'error');
                return;
            }

            if (fromDate > toDate) {
                this.showNotification('From date cannot be later than To date.', 'error');
                return;
            }

            const filtered = this.records.filter(r => r.date >= fromDate && r.date <= toDate);
            if (filtered.length === 0) {
                this.showNotification(`No records found from ${fromDate} to ${toDate}.`, 'warning');
                return;
            }

            this.closeExportModal();
            this._exportSummarySheet(filtered, `Custom Summary: ${fromDate} to ${toDate}`, `pacd_custom_${fromDate}_to_${toDate}.xlsx`);
        }
    }

    _exportSummarySheet(records, title, filename) {
        try {
            // Sort by date
            const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));

            // ── Detail rows ──
            const detailRows = sorted.map(r => ({
                'Date':               r.date,
                'Officer Name':       r.officer_name,
                'New Member':         r.new_member,
                'Amendment':          r.amendment,
                'Yakap Assignment':   r.yakap_assignment,
                'ER2':                r.er2,
                'Inquiry':            r.inquiry || 0,
                'Print ID/MDR':       r.print_id_mdr || 0,
                'Transactions':       r.total_transactions || 0,
                'Clients':            r.total_clients,
                'Answered Survey':    r.yes_count,
                'Did Not Answer':     r.no_count
            }));

            // ── Totals row ──
            const tot = (key) => sorted.reduce((s, r) => s + (r[key] || 0), 0);
            const totalYes = tot('yes_count');
            const totalClients = tot('total_clients');
            const satRate = totalClients > 0 ? ((totalYes / totalClients) * 100).toFixed(1) + '%' : 'N/A';

            detailRows.push({
                'Date':               'TOTAL',
                'Officer Name':       '',
                'New Member':         tot('new_member'),
                'Amendment':          tot('amendment'),
                'Yakap Assignment':   tot('yakap_assignment'),
                'ER2':                tot('er2'),
                'Inquiry':            tot('inquiry'),
                'Print ID/MDR':       tot('print_id_mdr'),
                'Transactions':       tot('total_transactions'),
                'Clients':            tot('total_clients'),
                'Answered Survey':    totalYes,
                'Did Not Answer':     tot('no_count')
            });

            // ── Per-officer summary ──
            const byOfficer = {};
            sorted.forEach(r => {
                if (!byOfficer[r.officer_name]) {
                    byOfficer[r.officer_name] = { days: 0, new_member: 0, amendment: 0, yakap_assignment: 0, er2: 0, inquiry: 0, print_id_mdr: 0, total_transactions: 0, total_clients: 0, yes_count: 0, no_count: 0 };
                }
                const o = byOfficer[r.officer_name];
                o.days++;
                o.new_member       += r.new_member || 0;
                o.amendment        += r.amendment || 0;
                o.yakap_assignment += r.yakap_assignment || 0;
                o.er2              += r.er2 || 0;
                o.inquiry          += r.inquiry || 0;
                o.print_id_mdr     += r.print_id_mdr || 0;
                o.total_transactions += r.total_transactions || 0;
                o.total_clients    += r.total_clients || 0;
                o.yes_count        += r.yes_count || 0;
                o.no_count         += r.no_count || 0;
            });

            const officerRows = Object.entries(byOfficer).map(([name, o]) => ({
                'Officer Name':       name,
                'Days':               o.days,
                'New Member':         o.new_member,
                'Amendment':          o.amendment,
                'Yakap Assignment':   o.yakap_assignment,
                'ER2':                o.er2,
                'Inquiry':            o.inquiry,
                'Print ID/MDR':       o.print_id_mdr,
                'Transactions':       o.total_transactions,
                'Clients':            o.total_clients,
                'Answered Survey':    o.yes_count,
                'Did Not Answer':     o.no_count,
                'Survey Response Rate': o.total_clients > 0 ? ((o.yes_count / o.total_clients) * 100).toFixed(1) + '%' : 'N/A'
            }));

            const workbook = XLSX.utils.book_new();

            // Sheet 1 — Daily Detail
            const ws1 = XLSX.utils.json_to_sheet(detailRows);
            ws1['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 16 }];
            XLSX.utils.book_append_sheet(workbook, ws1, 'Daily Detail');

            // Sheet 2 — Officer Summary
            const ws2 = XLSX.utils.json_to_sheet(officerRows);
            ws2['!cols'] = [{ wch: 28 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
            XLSX.utils.book_append_sheet(workbook, ws2, 'Officer Summary');

            XLSX.writeFile(workbook, filename);
            this.showNotification(`"${title}" exported successfully!`, 'success');
        } catch (error) {
            console.error('Summary export error:', error);
            this.showNotification('Error exporting summary.', 'error');
        }
    }

    backupData() {
        try {
            const records = this.records;
            const backupData = {
                version: '1.0',
                exportDate: new Date().toISOString(),
                records: records
            };
            
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pacd_backup_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            window.URL.revokeObjectURL(url);
            
            this.showNotification('Data backup created successfully!', 'success');
        } catch (error) {
            console.error('Backup error:', error);
            this.showNotification('Error creating backup.', 'error');
        }
    }

    restoreData() {
        document.getElementById('fileInput').click();
    }

    handleFileRestore(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const backupData = JSON.parse(event.target.result);
                
                if (!backupData.records || !Array.isArray(backupData.records)) {
                    throw new Error('Invalid backup file format');
                }
                
                this.confirmAction(
                    'Restore Data',
                    'This will ADD all backup records to the database. Continue?',
                    async () => {
                        for (const record of backupData.records) {
                            await addDoc(collection(db, 'pacd_records'), {
                                date:             record.date,
                                officer_name:     record.officer_name,
                                new_member:       record.new_member || 0,
                                amendment:        record.amendment || 0,
                                yakap_assignment: record.yakap_assignment || 0,
                                er2:              record.er2 || 0,
                                total_clients:    record.total_clients || 0,
                                yes_count:        record.yes_count || 0,
                                no_count:         record.no_count || 0,
                                created_at:       record.created_at || new Date().toISOString()
                            });
                        }
                        this.showNotification('Data restored successfully!', 'success');
                    },
                    'Restore',
                    'primary'
                );
            } catch (error) {
                console.error('Restore error:', error);
                this.showNotification('Error restoring data. Please check the file format.', 'error');
            }
        };
        
        reader.readAsText(file);
        e.target.value = '';
    }

    updateLastUpdated() {
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
        const dateString = now.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        
        const lastUpdatedElement = document.getElementById('lastUpdated');
        if (lastUpdatedElement) {
            lastUpdatedElement.textContent = `Last updated: ${dateString} at ${timeString}`;
        }
    }

    startClock() {
        // Update every second
        setInterval(() => {
            this.updateLastUpdated();
        }, 1000);
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        
        // Style the notification
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '12px 20px',
            borderRadius: '6px',
            color: 'white',
            fontWeight: '600',
            zIndex: '10000',
            maxWidth: '300px',
            wordWrap: 'break-word',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            transform: 'translateX(400px)',
            transition: 'transform 0.3s ease'
        });
        
        // Set background color based on type
        const colors = {
            success: '#28a745',
            error: '#dc3545',
            warning: '#ffc107',
            info: '#17a2b8'
        };
        notification.style.backgroundColor = colors[type] || colors.info;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 100);
        
        // Remove after 3 seconds
        setTimeout(() => {
            notification.style.transform = 'translateX(400px)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }
}

// Initialize the application when the page loads
// Must be on window so inline onclick handlers can access it from module scope
const app = new PACDMonitoringSystem();
window.app = app;

// Create a single admin — call from console: createAdmin('email', 'password', 'Full Name')
window.createAdmin = async (email, password, name = 'Admin') => {
    try {
        const secApp  = initializeApp(firebaseConfig, `admin-seed-${Date.now()}`);
        const secAuth = getAuth(secApp);
        const { user } = await createUserWithEmailAndPassword(secAuth, email, password);
        await signOut(secAuth);
        await deleteApp(secApp);
        await setDoc(doc(db, 'users', user.uid), {
            name, email, role: 'admin', disabled: false, created_at: serverTimestamp()
        });
        console.log(`Admin created: ${email}`);
    } catch (e) {
        console.error('Failed:', e.message);
    }
};

// One-time seed function — call window.seedAccounts() from the browser console
window.seedAccounts = async () => {
    const accounts = [
        { name: 'Admin User',    email: 'admin@memsec.com',   password: 'Admin@123',   role: 'admin'   },
        { name: 'Test Officer',  email: 'officer@memsec.com', password: 'Officer@123', role: 'officer' }
    ];
    for (const acct of accounts) {
        try {
            const secApp  = initializeApp(firebaseConfig, `seed-${Date.now()}`);
            const secAuth = getAuth(secApp);
            const { user } = await createUserWithEmailAndPassword(secAuth, acct.email, acct.password);
            await signOut(secAuth);
            await deleteApp(secApp);
            await setDoc(doc(db, 'users', user.uid), {
                name: acct.name, email: acct.email, role: acct.role,
                disabled: false, created_at: serverTimestamp()
            });
            console.log(`Created: ${acct.email}`);
        } catch (e) {
            console.warn(`Skipped ${acct.email}:`, e.message);
        }
    }
    console.log('Seeding done. You can now log in.');
};
