import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { BellRing, CheckCircle, AlertCircle, MessageCircle, Send, Loader2, Paperclip, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { subscribeToCustomers, Customer, subscribeToSettings, AppSettings, updateCustomer } from "../lib/db";
import { writeBatch, doc } from "firebase/firestore";
import { db } from "../firebase";
import { sendWhatsAppNotification } from "../lib/automation";
import { base64ToBlob } from "../lib/utils";
import { ConfirmModal } from "../components/ConfirmModal";
import { useRef } from "react";

export function AlertsView() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSendingBulk, setIsSendingBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [notifyingId, setNotifyingId] = useState<string | null>(null);
  const deliveryModeRef = useRef("api");
  const [customAttachment, setCustomAttachment] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDestructive: boolean;
    showCancel: boolean;
    children?: React.ReactNode;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
    isDestructive: false,
    showCancel: true
  });

  const showAlert = (title: string, message: string) => {
    setConfirmConfig({
      isOpen: true,
      title,
      message,
      onConfirm: () => {},
      isDestructive: false,
      showCancel: false
    });
  };

  useEffect(() => {
    const unsubCustomers = subscribeToCustomers(setCustomers);
    const unsubSettings = subscribeToSettings(setSettings);
    return () => {
      unsubCustomers();
      unsubSettings();
    };
  }, []);

  const [viewMode, setViewMode] = useState<'all' | 'paid' | 'paid_notified' | 'unpaid'>('all');
  const [manualQueue, setManualQueue] = useState<{customer: Customer, message: string, url: string}[] | null>(null);
  const [manualQueueIndex, setManualQueueIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  useEffect(() => {
    setCurrentPage(1);
  }, [viewMode]);

  if (!settings) return null;

  const paidCustomers = customers.filter(c => c.status === 'Active' && c.balance === 0 && !c.paymentNotified);
  const paidNotifiedCustomers = customers.filter(c => c.status === 'Active' && c.balance === 0 && c.paymentNotified);
  const unpaidCustomers = customers.filter(c => c.status === 'Active' && c.balance > 0);

  const displayedCustomers = viewMode === 'paid' ? paidCustomers : viewMode === 'paid_notified' ? paidNotifiedCustomers : viewMode === 'unpaid' ? unpaidCustomers : customers;
  const totalPages = Math.ceil(displayedCustomers.length / itemsPerPage);
  const paginatedCustomers = displayedCustomers.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0
    }).format(amount);
  };

  const handleSendWhatsApp = async (customer: Customer, isPaid: boolean) => {
    setNotifyingId(customer.id!);
    let message = "";
    let attachment: Blob | undefined = undefined;
    let fileName: string | undefined = undefined;
    
    if (isPaid) {
            message = `Dear ${customer.name}, thank you for your payment! Your account is now clear. We appreciate your promptness.`;
    } else {
      const penaltyAmount = customer.balance >= settings.billingAmount ? settings.penaltyAmount : 0;
      const totalAmount = customer.balance + penaltyAmount;
      message = `Dear ${customer.name}, your water bill of ${formatCurrency(totalAmount)} is pending (including late fees if applicable). Please pay immediately to avoid service disconnection.`;
    }

    if (customAttachment) {
      attachment = customAttachment;
      fileName = customAttachment.name;
    } else if (!isPaid && settings.upiQrCodeImage) {
      // Attach QR code if available
      try {
        attachment = base64ToBlob(settings.upiQrCodeImage);
        fileName = 'payment_qr.png';
      } catch (e) {
        console.error("Failed to convert QR code to blob", e);
      }
    }

    const result = await sendWhatsAppNotification(customer, message, settings, attachment, fileName, false);
    setNotifyingId(null);
    
    if (!result.success) {
      showAlert('Notice', `Could not notify ${customer.name}: ${result.error}`);
      return;
    }

    if (isPaid) {
      await updateCustomer({ ...customer, paymentNotified: true });
    }
  };

  const handleNotifyAllPaid = async () => {
    if (!settings) return;
    const targets = paidCustomers.filter(c => c.mobileNumber && c.mobileNumber.replace(/\D/g, '').length >= 10);
    if (targets.length === 0) return;
    
    deliveryModeRef.current = "api";

    setConfirmConfig({
      isOpen: true,
      title: "Notify Paid Customers",
      message: `Are you sure you want to notify all ${targets.length} valid paid customers?`,
      isDestructive: false,
      showCancel: true,
      children: (
        <div className="flex flex-col gap-2 mt-2">
          <label className="text-sm font-semibold">Delivery Method</label>
          <select 
            className="w-full px-3 py-2 bg-[var(--bg-color)] border border-[var(--shadow-light)] rounded-lg text-sm"
            onChange={(e) => deliveryModeRef.current = e.target.value}
            defaultValue="api"
          >
            <option value="api">WhatsApp Cloud API (Automated)</option>
            <option value="web">WhatsApp Web (Manual Prompts - Slow)</option>
          </select>
        </div>
      ),
      onConfirm: async () => {
        const isApiMode = deliveryModeRef.current === "api";

        if (!isApiMode) {
          const queue = targets.map((customer) => {
             const message = `Dear ${customer.name}, thank you for your payment! Your account is now clear. We appreciate your promptness.`;
             const mobile = customer.mobileNumber.replace(/\D/g, '');
             let formattedTo = mobile;
             if (mobile.length === 10) {
               formattedTo = `91${mobile}`;
             } else if (mobile.length === 12 && mobile.startsWith('91')) {
               formattedTo = mobile;
             } else {
               formattedTo = mobile.startsWith('91') ? mobile : `91${mobile}`;
             }
             const url = `https://wa.me/${formattedTo}?text=${encodeURIComponent(message)}`;
             return { customer, message, url, status: 'pending' as const };
          });
          setConfirmConfig({...confirmConfig, isOpen: false});
          setManualQueue(queue);
          setManualQueueIndex(0);
          return;
        }

        setIsSendingBulk(true);
        setBulkProgress(0);
        
        let errors = [];
        const tempSettings = { ...settings };

        const batch = writeBatch(db);
        let updatesSkipped = 0;

        for (let i = 0; i < targets.length; i++) {
          const customer = targets[i];
          let message = `Dear ${customer.name}, thank you for your payment! Your account is now clear. We appreciate your promptness.`;

          let attachment: Blob | undefined = undefined;
          let fileName: string | undefined = undefined;
          if (customAttachment) {
            attachment = customAttachment;
            fileName = customAttachment.name;
          }

          const result = await sendWhatsAppNotification(customer, message, tempSettings, attachment, fileName, true);
          if (result.success) {
             batch.update(doc(db, 'customers', customer.id), { paymentNotified: true });
             updatesSkipped++;

             if (updatesSkipped % 100 === 0) {
                 try {
                     await batch.commit();
                 } catch (e: any) {
                     if (e.code === 'resource-exhausted') {
                         errors.push("Quota Exceeded: Reached Firebase free limits.");
                         break;
                     }
                 }
             }
          } else {
             errors.push(`${customer.name}: ${result.error}`);
          }
          
          setBulkProgress(Math.floor(((i + 1) / targets.length) * 100));
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (updatesSkipped % 100 !== 0) {
            try {
                await batch.commit();
            } catch (e: any) {
                if (e.code === 'resource-exhausted') errors.push("Quota Exceeded: Reached Firebase free limits.");
            }
        }
        
        setIsSendingBulk(false);
        if (errors.length > 0) {
          setConfirmConfig({
            isOpen: true,
            title: "API Delivery Failed",
            message: `Some customers couldn't be notified via API:\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? '\n...' : ''}\n\nWould you like to use the manual fallback to select and message them in WhatsApp?`,
            isDestructive: false,
            showCancel: true,
            onConfirm: () => {
              const queue = targets.map((customer) => {
                 const message = `Dear ${customer.name}, thank you for your payment! Your account is now clear. We appreciate your promptness.`;
                 const mobile = customer.mobileNumber.replace(/\D/g, '');
                 let formattedTo = mobile;
                 if (mobile.length === 10) formattedTo = `91${mobile}`;
                 else if (mobile.length === 12 && mobile.startsWith('91')) formattedTo = mobile;
                 else formattedTo = mobile.startsWith('91') ? mobile : `91${mobile}`;
                 const url = `https://wa.me/${formattedTo}?text=${encodeURIComponent(message)}`;
                 return { customer, message, url, status: 'pending' as const };
              });
              setConfirmConfig({...confirmConfig, isOpen: false});
              setManualQueue(queue);
              setManualQueueIndex(0);
            }
          });
        } else {
           showAlert('Notice', "All valid paid customers have been notified!");
        }
      }
    });
  };

  const handleNotifyAllUnpaid = async () => {
    if (!settings) return;
    const targets = unpaidCustomers.filter(c => c.mobileNumber && c.mobileNumber.replace(/\D/g, '').length >= 10);
    if (targets.length === 0) return;
    
    deliveryModeRef.current = "api";

    setConfirmConfig({
      isOpen: true,
      title: "Notify Unpaid Customers",
      message: `Are you sure you want to notify all ${targets.length} valid unpaid customers?`,
      isDestructive: false,
      showCancel: true,
      children: (
        <div className="flex flex-col gap-2 mt-2">
          <label className="text-sm font-semibold">Delivery Method</label>
          <select 
            className="w-full px-3 py-2 bg-[var(--bg-color)] border border-[var(--shadow-light)] rounded-lg text-sm"
            onChange={(e) => deliveryModeRef.current = e.target.value}
            defaultValue="api"
          >
            <option value="api">WhatsApp Cloud API (Automated)</option>
            <option value="web">WhatsApp Web (Manual Prompts - Slow)</option>
          </select>
        </div>
      ),
      onConfirm: async () => {
        const isApiMode = deliveryModeRef.current === "api";

        if (!isApiMode) {
          const queue = targets.map((customer) => {
             const penaltyAmount = customer.balance >= settings.billingAmount ? settings.penaltyAmount : 0;
             const totalAmount = customer.balance + penaltyAmount;
             const message = `Dear ${customer.name}, your water bill of ${formatCurrency(totalAmount)} is pending. Please pay immediately to avoid service disconnection.`;
             const mobile = customer.mobileNumber.replace(/\D/g, '');
             let formattedTo = mobile;
             if (mobile.length === 10) formattedTo = `91${mobile}`;
             else if (mobile.length === 12 && mobile.startsWith('91')) formattedTo = mobile;
             else formattedTo = mobile.startsWith('91') ? mobile : `91${mobile}`;
             const url = `https://wa.me/${formattedTo}?text=${encodeURIComponent(message)}`;
             return { customer, message, url, status: 'pending' as const };
          });
          setConfirmConfig({...confirmConfig, isOpen: false});
          setManualQueue(queue);
          setManualQueueIndex(0);
          return;
        }

        setIsSendingBulk(true);
        setBulkProgress(0);
        
        let errors = [];
        const tempSettings = { ...settings };

        for (let i = 0; i < targets.length; i++) {
          const customer = targets[i];
          const penaltyAmount = customer.balance >= settings.billingAmount ? settings.penaltyAmount : 0;
          const totalAmount = customer.balance + penaltyAmount;
          let message = `Dear ${customer.name}, your water bill of ${formatCurrency(totalAmount)} is pending. Please pay immediately to avoid service disconnection.`;
          
          let attachment: Blob | undefined = undefined;
          let fileName: string | undefined = undefined;

          if (customAttachment) {
            attachment = customAttachment;
            fileName = customAttachment.name;
          } else if (settings.upiQrCodeImage) {
            try {
              attachment = base64ToBlob(settings.upiQrCodeImage);
              fileName = 'payment_qr.png';
            } catch (e) {
              console.error("Failed to convert QR code to blob", e);
            }
          }

          const result = await sendWhatsAppNotification(customer, message, tempSettings, attachment, fileName, true);
          if (!result.success) {
             errors.push(`${customer.name}: ${result.error}`);
          }
          
          setBulkProgress(Math.floor(((i + 1) / targets.length) * 100));
          
          // Small delay to prevent rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        setIsSendingBulk(false);
        if (errors.length > 0) {
          setConfirmConfig({
            isOpen: true,
            title: "API Delivery Failed",
            message: `Some customers couldn't be notified via API:\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? '\n...' : ''}\n\nWould you like to use the manual fallback to select and message them in WhatsApp?`,
            isDestructive: false,
            showCancel: true,
            onConfirm: () => {
              const queue = targets.map((customer) => {
                 const penaltyAmount = customer.balance >= settings.billingAmount ? settings.penaltyAmount : 0;
                 const totalAmount = customer.balance + penaltyAmount;
                 const message = `Dear ${customer.name}, your water bill of ${formatCurrency(totalAmount)} is pending. Please pay immediately to avoid service disconnection.`;
                 const mobile = customer.mobileNumber.replace(/\D/g, '');
                 let formattedTo = mobile;
                 if (mobile.length === 10) formattedTo = `91${mobile}`;
                 else if (mobile.length === 12 && mobile.startsWith('91')) formattedTo = mobile;
                 else formattedTo = mobile.startsWith('91') ? mobile : `91${mobile}`;
                 const url = `https://wa.me/${formattedTo}?text=${encodeURIComponent(message)}`;
                 return { customer, message, url, status: 'pending' as const };
              });
              setConfirmConfig({...confirmConfig, isOpen: false});
              setManualQueue(queue);
              setManualQueueIndex(0);
            }
          });
        } else {
           showAlert('Notice', "All valid unpaid customers have been notified!");
        }
      }
    });
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="space-y-6"
    >
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Alerts & Notifications</h2>
          <p className="neu-text-muted">Monitor payments and send reminders</p>
        </div>
        <div className="flex items-center gap-3">
          <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            onChange={(e) => setCustomAttachment(e.target.files?.[0] || null)}
          />
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-sm font-bold shadow-sm hover:bg-slate-200 transition-colors flex items-center gap-2"
          >
            {customAttachment ? (
              <>
                <CheckCircle className="w-4 h-4 text-emerald-600" /> 
                <span className="truncate max-w-[120px]">{customAttachment.name}</span>
                <div 
                  className="p-1 hover:bg-slate-300 rounded-full ml-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCustomAttachment(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <X className="w-3 h-3 text-rose-500" />
                </div>
              </>
            ) : (
              <>
                <Paperclip className="w-4 h-4" /> Attach File
              </>
            )}
          </button>
        </div>
        {unpaidCustomers.length > 0 && viewMode === 'unpaid' && (
          <div className="flex items-center gap-3">
            <button 
              onClick={handleNotifyAllUnpaid}
              disabled={isSendingBulk || !settings?.automation?.bulkProcessing}
              className="px-4 py-2 bg-rose-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-rose-500/30 hover:bg-rose-700 transition-colors disabled:opacity-70 flex items-center gap-2"
            >
              {isSendingBulk ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Notifying... {bulkProgress}%
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" /> Notify All Unpaid
                </>
              )}
            </button>
          </div>
        )}
        {(viewMode === 'paid' || viewMode === 'paid_notified') && (
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setViewMode(viewMode === 'paid' ? 'paid_notified' : 'paid')}
              className="px-4 py-2 neu-flat text-emerald-600 rounded-xl text-sm font-bold hover:bg-emerald-500/10 transition-colors"
            >
              {viewMode === 'paid' ? 'Show Sent Messages' : 'Back to Pending Notifications'}
            </button>
            {paidCustomers.length > 0 && viewMode === 'paid' && (
              <button 
                onClick={handleNotifyAllPaid}
                disabled={isSendingBulk || !settings?.automation?.bulkProcessing}
                className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-500/30 hover:bg-emerald-700 transition-colors disabled:opacity-70 flex items-center gap-2"
              >
                {isSendingBulk ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Notifying... {bulkProgress}%
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" /> Notify All Paid
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <motion.div 
          whileHover={{ scale: 1.05, y: -5 }} 
          whileTap={{ scale: 0.95 }}
          onClick={() => setViewMode('paid')}
        >
          <Card className="bg-emerald-500/10 border-emerald-500/20 cursor-pointer hover:bg-emerald-500/20 transition-all shadow-lg hover:shadow-emerald-500/20">
            <CardContent className="p-6 flex items-center gap-4">
              <motion.div 
                whileHover={{ rotate: 360 }}
                transition={{ duration: 0.5 }}
                className="p-4 bg-emerald-500/20 rounded-2xl text-emerald-600"
              >
                <CheckCircle className="w-8 h-8" />
              </motion.div>
              <div>
                <p className="text-sm font-bold text-emerald-600/80 uppercase tracking-wider">Paid Customers</p>
                <h3 className="text-3xl font-black text-emerald-700">{paidCustomers.length}</h3>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div 
          whileHover={{ scale: 1.05, y: -5 }} 
          whileTap={{ scale: 0.95 }}
          onClick={() => setViewMode('unpaid')}
        >
          <Card className="bg-rose-500/10 border-rose-500/20 cursor-pointer hover:bg-rose-500/20 transition-all shadow-lg hover:shadow-rose-500/20">
            <CardContent className="p-6 flex items-center gap-4">
              <motion.div 
                whileHover={{ rotate: 360 }}
                transition={{ duration: 0.5 }}
                className="p-4 bg-rose-500/20 rounded-2xl text-rose-600"
              >
                <AlertCircle className="w-8 h-8" />
              </motion.div>
              <div>
                <p className="text-sm font-bold text-rose-600/80 uppercase tracking-wider">Unpaid Customers</p>
                <h3 className="text-3xl font-black text-rose-700">{unpaidCustomers.length}</h3>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        
        <motion.div 
          whileHover={{ scale: 1.05, y: -5 }} 
          whileTap={{ scale: 0.95 }}
          onClick={() => setViewMode('all')}
        >
          <Card className="bg-blue-500/10 border-blue-500/20 cursor-pointer hover:bg-blue-500/20 transition-all shadow-lg hover:shadow-blue-500/20">
            <CardContent className="p-6 flex items-center gap-4">
              <motion.div 
                whileHover={{ rotate: 360 }}
                transition={{ duration: 0.5 }}
                className="p-4 bg-blue-500/20 rounded-2xl text-blue-600"
              >
                <BellRing className="w-8 h-8" />
              </motion.div>
              <div>
                <p className="text-sm font-bold text-blue-600/80 uppercase tracking-wider">Total Pending</p>
                <h3 className="text-3xl font-black text-blue-700">
                  {formatCurrency(unpaidCustomers.reduce((acc, c) => acc + c.balance, 0))}
                </h3>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {viewMode === 'paid' ? 'Paid (Notification Pending)' : 
             viewMode === 'paid_notified' ? 'Paid & Notified' : 
             viewMode === 'unpaid' ? 'Unpaid Customers' : 'All Customers'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase neu-text-muted border-b border-[var(--shadow-dark)]">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Mobile</th>
                  <th className="px-4 py-3 text-right">Outstanding</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {paginatedCustomers.map((customer, i) => {
                  const isPaid = customer.balance === 0;
                  return (
                    <motion.tr 
                      key={customer.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.01 }}
                      className="border-b border-[var(--shadow-dark)] last:border-0 hover:bg-black/5 transition-colors"
                    >
                      <td className="px-4 py-4">
                        <p className="font-bold">{customer.name}</p>
                        <p className="text-xs neu-text-muted">{customer.id}</p>
                      </td>
                      <td className="px-4 py-4 text-neu-text-muted">{customer.mobileNumber}</td>
                      <td className="px-4 py-4 text-right font-medium text-rose-600">
                        {formatCurrency(customer.balance)}
                      </td>
                      <td className="px-4 py-4 text-center">
                        {!customer.mobileNumber || customer.mobileNumber.replace(/\D/g, '').length < 10 ? (
                          <span className="px-2 py-1 bg-slate-200 text-slate-700 rounded-full text-xs font-bold">Suspended</span>
                        ) : isPaid ? (
                          <span className={`px-2 py-1 rounded-full text-xs font-bold ${customer.paymentNotified ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                            {customer.paymentNotified ? 'Paid & Notified' : 'Paid'}
                          </span>
                        ) : (
                          <span className="px-2 py-1 bg-rose-100 text-rose-700 rounded-full text-xs font-bold">Unpaid</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-center">
                        {(!customer.mobileNumber || customer.mobileNumber.replace(/\D/g, '').length < 10) ? null : (
                            <button 
                              onClick={() => handleSendWhatsApp(customer, isPaid)}
                              disabled={notifyingId === customer.id}
                              className={`px-3 py-2 text-white rounded-xl text-xs font-bold shadow-lg transition-colors inline-flex items-center gap-2 ${
                                isPaid ? 'bg-[#25D366] shadow-[#25D366]/30 hover:bg-[#1ebd5a]' : 'bg-rose-600 shadow-rose-500/30 hover:bg-rose-700'
                              } disabled:opacity-70`}
                            >
                              {notifyingId === customer.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageCircle className="w-4 h-4" />}
                              {notifyingId === customer.id ? 'Sending...' : (isPaid && customer.paymentNotified ? 'Resend' : 'Notify')}
                            </button>
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
                {paginatedCustomers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center neu-text-muted">
                      No customers found in this category.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            
            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-4 border-t border-[var(--shadow-dark)]">
                <span className="text-sm neu-text-muted">
                  Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, displayedCustomers.length)} of {displayedCustomers.length} customers
                </span>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="px-3 py-1 neu-flat rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    Previous
                  </button>
                  <div className="px-3 py-1 text-sm font-medium flex items-center">
                    Page {currentPage} of {totalPages}
                  </div>
                  <button 
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1 neu-flat rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmModal
        isOpen={confirmConfig.isOpen}
        onClose={() => setConfirmConfig({ ...confirmConfig, isOpen: false })}
        onConfirm={confirmConfig.onConfirm}
        title={confirmConfig.title}
        message={confirmConfig.message}
        isDestructive={confirmConfig.isDestructive}
        showCancel={confirmConfig.showCancel}
      >
        {confirmConfig.children}
      </ConfirmModal>

      {/* Manual Queue Modal */}
      {manualQueue && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="neu-flat rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl relative max-h-[90vh] flex flex-col"
          >
            <h2 className="text-2xl font-bold mb-2">Manual Delivery Queue</h2>
            <p className="text-sm neu-text-muted mb-4">
              Sending {manualQueueIndex + 1} of {manualQueue.length}
            </p>
            
            <div className="w-full bg-slate-200 rounded-full h-2.5 mb-6 overflow-hidden">
              <div 
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                style={{ width: `${(manualQueueIndex / manualQueue.length) * 100}%` }}
              ></div>
            </div>

            <div className="flex-1 overflow-auto rounded-xl border border-[var(--shadow-dark)] p-4 mb-6 bg-black/5">
              {manualQueueIndex < manualQueue.length ? (
                <>
                  <p className="font-bold text-lg mb-1">{manualQueue[manualQueueIndex].customer.name}</p>
                  <p className="text-xs text-blue-600 font-mono mb-4">{manualQueue[manualQueueIndex].customer.mobileNumber}</p>
                  <p className="text-sm whitespace-pre-wrap neu-text-muted">{manualQueue[manualQueueIndex].message}</p>
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-4">
                    <CheckCircle className="w-8 h-8" />
                  </div>
                  <p className="font-bold text-lg">All caught up!</p>
                  <p className="text-sm neu-text-muted">You have processed the entire manual queue.</p>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-auto">
              <button
                onClick={() => setManualQueue(null)}
                className="flex-1 px-4 py-3 neu-flat rounded-xl font-bold"
              >
                {manualQueueIndex < manualQueue.length ? 'Cancel Queue' : 'Close'}
              </button>
              {manualQueueIndex < manualQueue.length && (
                <button
                  onClick={() => {
                     // Mark current as done
                     const newQueue = [...manualQueue];
                     newQueue[manualQueueIndex].status = 'done';
                     setManualQueue(newQueue);
                     
                     // If it's a paid customer, update paymentNotified
                     if (viewMode === 'paid' || viewMode === 'all') {
                        if (manualQueue[manualQueueIndex].message.includes("thank you for your payment")) {
                           updateCustomer({ ...manualQueue[manualQueueIndex].customer, paymentNotified: true }).catch(console.error);
                        }
                     }

                     window.open(manualQueue[manualQueueIndex].url, '_blank');
                     setManualQueueIndex(i => i + 1);
                  }}
                  className="flex-1 px-4 py-3 bg-[#25D366] text-white hover:bg-[#1ebd5a] rounded-xl font-bold shadow-lg shadow-[#25D366]/30 transition-colors flex justify-center items-center gap-2"
                >
                  <Send className="w-4 h-4" /> Send Now
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
