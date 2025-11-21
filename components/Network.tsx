

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { RouterConfigWithId, VlanInterface, Interface, IpAddress, IpRoute, IpRouteData, WanRoute, FailoverStatus, DhcpServer, DhcpLease, IpPool, DhcpServerData, DhcpServerSetupParams } from '../types.ts';
import { 
    getVlans, addVlan, deleteVlan, getInterfaces, getIpAddresses, getIpRoutes, 
    addIpRoute, updateIpRoute, deleteIpRoute, getWanRoutes, getWanFailoverStatus,
    setRouteProperty, configureWanFailover,
    getDhcpServers, addDhcpServer, updateDhcpServer, deleteDhcpServer,
    getDhcpLeases, makeLeaseStatic, deleteDhcpLease, runDhcpSetup, getIpPools,
    addIpPool, updateIpPool, deleteIpPool
} from '../services/mikrotikService.ts';
import { generateMultiWanScript } from '../services/geminiService.ts';
import { Loader } from './Loader.tsx';
import { RouterIcon, TrashIcon, VlanIcon, ShareIcon, EditIcon, ShieldCheckIcon, ServerIcon, CircleStackIcon, BridgeIcon } from '../constants.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { Firewall } from './Firewall.tsx';
import { DhcpCaptivePortalInstaller } from './DhcpCaptivePortalInstaller.tsx';
import { BridgeManager } from './BridgeManager.tsx';


// Reusable ToggleSwitch component
const ToggleSwitch: React.FC<{ checked: boolean; onChange: () => void; disabled?: boolean; }> = ({ checked, onChange, disabled }) => (
    <label className="relative inline-flex items-center cursor-pointer">
        <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            disabled={disabled}
            className="sr-only peer"
        />
        <div className="w-11 h-6 bg-slate-200 dark:bg-slate-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-[--color-primary-500] peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[--color-primary-600] disabled:opacity-50"></div>
    </label>
);

// --- DHCP Management Component & Sub-components ---
type DhcpView = 'servers' | 'leases' | 'installer';

const DhcpServerFormModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSave: (serverData: DhcpServerData, serverId?: string) => void;
    initialData: DhcpServer | null;
    interfaces: Interface[];
    pools: IpPool[];
    isLoading: boolean;
}> = ({ isOpen, onClose, onSave, initialData, interfaces, pools, isLoading }) => {
    const [server, setServer] = useState<DhcpServerData>({});

    useEffect(() => {
        if (isOpen) {
            const defaults = {
                name: '',
                interface: interfaces.length > 0 ? interfaces[0].name : '',
                'address-pool': pools.length > 0 ? pools[0].name : 'none',
                'lease-time': '00:10:00',
                disabled: 'false' as const
            };
            setServer(initialData ? { ...initialData } : defaults);
        }
    }, [initialData, isOpen, interfaces, pools]);
    
    if (!isOpen) return null;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setServer(s => ({...s, [name]: value}));
    };
    
    const handleToggle = () => {
        setServer(s => ({...s, disabled: s.disabled === 'true' ? 'false' : 'true'}));
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(server, initialData?.id);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg">
                <form onSubmit={handleSubmit}>
                    <div className="p-6">
                        <h3 className="text-xl font-bold mb-4">{initialData ? 'Edit DHCP Server' : 'Add DHCP Server'}</h3>
                        <div className="space-y-4">
                            <div><label>Server Name</label><input name="name" value={server.name} onChange={handleChange} required className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"/></div>
                            <div><label>Interface</label><select name="interface" value={server.interface} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md">{interfaces.map(i=><option key={i.id} value={i.name}>{i.name}</option>)}</select></div>
                            <div><label>Address Pool</label><select name="address-pool" value={server['address-pool']} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"><option value="none">none</option>{pools.map(p=><option key={p.id} value={p.name}>{p.name}</option>)}</select></div>
                            <div><label>Lease Time</label><input name="lease-time" value={server['lease-time']} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"/></div>
                            <div className="flex items-center gap-4"><label>Disabled</label><ToggleSwitch checked={server.disabled === 'true'} onChange={handleToggle}/></div>
                        </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 px-6 py-3 flex justify-end gap-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-md">Cancel</button>
                        <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[--color-primary-600] text-white rounded-md disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};


const DhcpSmartInstaller: React.FC<{
    selectedRouter: RouterConfigWithId,
    interfaces: Interface[],
    onSuccess: () => void,
}> = ({ selectedRouter, interfaces, onSuccess }) => {
    const [params, setParams] = useState<DhcpServerSetupParams>({
        dhcpInterface: interfaces.find(i => i.type === 'bridge')?.name || interfaces[0]?.name || '',
        dhcpAddressSpace: '192.168.88.0/24',
        gateway: '192.168.88.1',
        addressPool: '192.168.88.2-192.168.88.254',
        dnsServers: '8.8.8.8,1.1.1.1',
        leaseTime: '00:10:00'
    });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    const getGatewayFromNetwork = (network: string): string => {
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(network)) return '';
        const ipParts = network.split('/')[0].split('.');
        ipParts[3] = '1';
        return ipParts.join('.');
    };
    
    const getPoolFromNetwork = (network: string): string => {
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(network)) return '';
        const [ip, cidrStr] = network.split('/');
        const ipParts = ip.split('.').map(Number);
        const cidr = parseInt(cidrStr, 10);
        if (cidr < 8 || cidr > 30) return '';
        const startIp = [...ipParts];
        startIp[3] = 2; 
        const ipAsInt = (ipParts[0] << 24 | ipParts[1] << 16 | ipParts[2] << 8 | ipParts[3]) >>> 0;
        const subnetMask = (0xffffffff << (32 - cidr)) >>> 0;
        const networkAddress = ipAsInt & subnetMask;
        const broadcastAddress = networkAddress | ~subnetMask;
        const endIpParts = [(broadcastAddress >> 24) & 255, (broadcastAddress >> 16) & 255, (broadcastAddress >> 8) & 255, (broadcastAddress & 255) - 1];
        return `${startIp.join('.')}-${endIpParts.join('.')}`;
    };
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setParams(p => {
            const newParams = { ...p, [name]: value };
            if (name === 'dhcpAddressSpace') {
                newParams.gateway = getGatewayFromNetwork(value);
                newParams.addressPool = getPoolFromNetwork(value);
            }
            return newParams;
        });
    };
    
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setError('');
        try {
            await runDhcpSetup(selectedRouter, params);
            alert('DHCP Server setup successful!');
            onSuccess();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md border border-slate-200 dark:border-slate-700">
                <div className="p-4 border-b border-slate-200 dark:border-slate-700">
                    <h3 className="font-semibold">DHCP Smart Installer</h3>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {error && <div className="p-3 bg-red-100 text-red-700 rounded-md">{error}</div>}
                    <div><label className="text-sm font-medium">DHCP Server Interface</label><select name="dhcpInterface" value={params.dhcpInterface} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md">{interfaces.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}</select></div>
                    <div><label className="text-sm font-medium">DHCP Address Space</label><input name="dhcpAddressSpace" value={params.dhcpAddressSpace} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                    <div><label className="text-sm font-medium">Gateway for DHCP Network</label><input name="gateway" value={params.gateway} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                    <div><label className="text-sm font-medium">Addresses to Give Out</label><input name="addressPool" value={params.addressPool} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                    <div><label className="text-sm font-medium">DNS Servers</label><input name="dnsServers" value={params.dnsServers} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                    <div><label className="text-sm font-medium">Lease Time</label><input name="leaseTime" value={params.leaseTime} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                    <div className="flex justify-end pt-4"><button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[--color-primary-600] text-white font-bold rounded-lg disabled:opacity-50">{isSubmitting ? 'Working...' : 'Run Setup'}</button></div>
                </form>
            </div>
        </div>
    );
};


const DhcpManager: React.FC<{ selectedRouter: RouterConfigWithId }> = ({ selectedRouter }) => {
    const [dhcpView, setDhcpView] = useState<DhcpView>('servers');
    const [servers, setServers] = useState<DhcpServer[]>([]);
    const [leases, setLeases] = useState<DhcpLease[]>([]);
    const [interfaces, setInterfaces] = useState<Interface[]>([]);
    const [pools, setPools] = useState<IpPool[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingServer, setEditingServer] = useState<DhcpServer | null>(null);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [serversData, leasesData, interfacesData, poolsData] = await Promise.all([
                getDhcpServers(selectedRouter),
                getDhcpLeases(selectedRouter),
                getInterfaces(selectedRouter),
                getIpPools(selectedRouter)
            ]);
            setServers(serversData);
            setLeases(leasesData);
            setInterfaces(interfacesData);
            setPools(poolsData);
        } catch (err) {
            setError(`Failed to fetch DHCP data: ${(err as Error).message}`);
        } finally {
            setIsLoading(false);
        }
    }, [selectedRouter]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);
    
    const handleSaveServer = async (serverData: DhcpServerData, serverId?: string) => {
        setIsSubmitting(true);
        try {
            if (serverId) {
                await updateDhcpServer(selectedRouter, serverId, serverData);
            } else {
                await addDhcpServer(selectedRouter, serverData as Required<DhcpServerData>);
            }
            setIsModalOpen(false);
            await fetchData();
        } catch (err) {
            alert(`Failed to save server: ${(err as Error).message}`);
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const handleDeleteServer = async (serverId: string) => {
        if (!window.confirm("Are you sure?")) return;
        try {
            await deleteDhcpServer(selectedRouter, serverId);
            await fetchData();
        } catch (err) {
            alert(`Failed to delete server: ${(err as Error).message}`);
        }
    };

    const handleMakeStatic = async (leaseId: string) => {
        try {
            await makeLeaseStatic(selectedRouter, leaseId);
            await fetchData();
        } catch (err) {
             alert(`Failed to make lease static: ${(err as Error).message}`);
        }
    };
    
    const handleDeleteLease = async (leaseId: string) => {
        if (!window.confirm("Are you sure?")) return;
        try {
            await deleteDhcpLease(selectedRouter, leaseId);
            await fetchData();
        } catch (err) {
            alert(`Failed to delete lease: ${(err as Error).message}`);
        }
    };

    const getLeaseStatusChip = (status: string) => {
        switch (status) {
            case 'bound': return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400">Bound</span>;
            case 'waiting': return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400">Waiting</span>;
            default: return <span className="px-2 py-1 text-xs font-semibold rounded-full bg-slate-200 dark:bg-slate-600/50 text-slate-600 dark:text-slate-400">{status}</span>;
        }
    };
    
    const renderContent = () => {
        if (isLoading) return <div className="flex justify-center p-8"><Loader /></div>
        if (error) return <div className="p-4 bg-red-100 text-red-700 rounded-md">{error}</div>

        switch(dhcpView) {
            case 'servers': return (
                <div>
                    <div className="flex justify-end mb-4"><button onClick={() => { setEditingServer(null); setIsModalOpen(true); }} className="bg-[--color-primary-600] text-white font-bold py-2 px-4 rounded-lg">Add Server</button></div>
                    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md overflow-hidden"><table className="w-full text-sm">
                        <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-900/50"><tr><th className="px-6 py-3">Name</th><th className="px-6 py-3">Interface</th><th className="px-6 py-3">Address Pool</th><th className="px-6 py-3">Lease Time</th><th className="px-6 py-3">Status</th><th className="px-6 py-3 text-right">Actions</th></tr></thead>
                        <tbody>{servers.map(s => <tr key={s.id} className={`border-b dark:border-slate-700 ${s.disabled==='true' ? 'opacity-50':''}`}>
                            <td className="px-6 py-4">{s.name}</td><td>{s.interface}</td><td>{s['address-pool']}</td><td>{s['lease-time']}</td>
                            <td>{s.disabled==='true' ? <span className="text-red-500">Disabled</span> : <span className="text-green-500">Enabled</span>}</td>
                            <td className="px-6 py-4 text-right space-x-2"><button onClick={() => { setEditingServer(s); setIsModalOpen(true); }}><EditIcon className="w-5 h-5"/></button><button onClick={()=>handleDeleteServer(s.id)}><TrashIcon className="w-5 h-5"/></button></td>
                        </tr>)}</tbody>
                    </table></div>
                </div>
            );
            case 'leases': return (
                <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md overflow-hidden"><table className="w-full text-sm">
                    <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-900/50"><tr><th className="px-6 py-3">IP Address</th><th className="px-6 py-3">MAC Address</th><th className="px-6 py-3">Server</th><th className="px-6 py-3">Status</th><th className="px-6 py-3">Type</th><th className="px-6 py-3 text-right">Actions</th></tr></thead>
                    <tbody>{leases.map(l => <tr key={l.id} className="border-b dark:border-slate-700">
                        <td className="px-6 py-4 font-mono">{l.address}</td><td className="font-mono">{l['mac-address']}</td><td>{l.server}</td><td>{getLeaseStatusChip(l.status)}</td>
                        <td>{l.dynamic==='true' ? 'Dynamic' : 'Static'}</td>
                        <td className="px-6 py-4 text-right space-x-2">
                            {l.dynamic === 'true' && <button onClick={() => handleMakeStatic(l.id)} className="text-sm text-sky-600">Make Static</button>}
                            <button onClick={()=>handleDeleteLease(l.id)}><TrashIcon className="w-5 h-5"/></button>
                        </td>
                    </tr>)}</tbody>
                </table></div>
            );
            case 'installer': return <DhcpSmartInstaller selectedRouter={selectedRouter} interfaces={interfaces} onSuccess={fetchData} />;
        }
    };

    return (
        <div className="space-y-4">
             <DhcpServerFormModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSave={handleSaveServer} initialData={editingServer} interfaces={interfaces} pools={pools} isLoading={isSubmitting} />
             <div className="flex border-b border-slate-200 dark:border-slate-700">
                <button onClick={() => setDhcpView('servers')} className={`px-4 py-2 text-sm ${dhcpView === 'servers' ? 'border-b-2 border-[--color-primary-500]' : ''}`}>Servers</button>
                <button onClick={() => setDhcpView('leases')} className={`px-4 py-2 text-sm ${dhcpView === 'leases' ? 'border-b-2 border-[--color-primary-500]' : ''}`}>Leases</button>
                <button onClick={() => setDhcpView('installer')} className={`px-4 py-2 text-sm ${dhcpView === 'installer' ? 'border-b-2 border-[--color-primary-500]' : ''}`}>Smart Installer</button>
            </div>
            {renderContent()}
        </div>
    );
};


// --- VLAN Add/Edit Modal ---
interface VlanFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (vlanData: Omit<VlanInterface, 'id'>) => void;
    interfaces: Interface[];
    isLoading: boolean;
}

const VlanFormModal: React.FC<VlanFormModalProps> = ({ isOpen, onClose, onSave, interfaces, isLoading }) => {
    const [vlanData, setVlanData] = useState({ name: '', 'vlan-id': '', interface: '' });

    useEffect(() => {
        if (isOpen) {
            // Reset form and select first available physical interface
            const firstPhysicalInterface = interfaces.find(i => i.type === 'ether' || i.type === 'sfp' || i.type === 'wlan')?.name || '';
            setVlanData({ name: '', 'vlan-id': '', interface: firstPhysicalInterface });
        }
    }, [isOpen, interfaces]);

    if (!isOpen) return null;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setVlanData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(vlanData);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg">
                <form onSubmit={handleSubmit}>
                    <div className="p-6">
                        <h3 className="text-xl font-bold mb-4">Add VLAN Interface</h3>
                        <div className="space-y-4">
                            <div><label>VLAN Name</label><input name="name" value={vlanData.name} onChange={handleChange} required className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div><label>VLAN ID</label><input type="number" name="vlan-id" value={vlanData['vlan-id']} onChange={handleChange} required min="1" max="4094" className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md" /></div>
                                <div><label>Interface</label><select name="interface" value={vlanData.interface} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md">{interfaces.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}</select></div>
                            </div>
                        </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 px-6 py-3 flex justify-end gap-4">
                        <button type="button" onClick={onClose} disabled={isLoading}>Cancel</button>
                        <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[--color-primary-600] text-white rounded-md disabled:opacity-50">{isLoading ? 'Adding...' : 'Add VLAN'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const VlanManager: React.FC<{ selectedRouter: RouterConfigWithId, interfaces: Interface[], onDataChange: () => void }> = ({ selectedRouter, interfaces, onDataChange }) => {
    const [vlans, setVlans] = useState<VlanInterface[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await getVlans(selectedRouter);
            setVlans(data);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, [selectedRouter]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSave = async (vlanData: Omit<VlanInterface, 'id'>) => {
        setIsSubmitting(true);
        try {
            await addVlan(selectedRouter, vlanData);
            setIsModalOpen(false);
            await fetchData();
            onDataChange(); // Notify parent to refetch interfaces
        } catch (err) {
            alert(`Failed to add VLAN: ${(err as Error).message}`);
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const handleDelete = async (vlanId: string) => {
        if (!window.confirm("Are you sure you want to delete this VLAN interface?")) return;
        setIsSubmitting(true);
        try {
            await deleteVlan(selectedRouter, vlanId);
            await fetchData();
            onDataChange();
        } catch (err) {
            alert(`Failed to delete VLAN: ${(err as Error).message}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isLoading) return <div className="flex justify-center p-8"><Loader /></div>;
    if (error) return <div className="p-4 bg-red-100 text-red-700">{error}</div>;

    return (
        <div>
            <VlanFormModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSave={handleSave} interfaces={interfaces} isLoading={isSubmitting} />
            <div className="flex justify-end mb-4">
                <button onClick={() => setIsModalOpen(true)} className="bg-[--color-primary-600] text-white font-bold py-2 px-4 rounded-lg">Add VLAN</button>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-900/50">
                        <tr>
                            <th className="px-6 py-3">Name</th>
                            <th className="px-6 py-3">VLAN ID</th>
                            <th className="px-6 py-3">Interface</th>
                            <th className="px-6 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {vlans.map(v => (
                            <tr key={v.id} className="border-b dark:border-slate-700">
                                <td className="px-6 py-4 font-medium">{v.name}</td>
                                <td>{v['vlan-id']}</td>
                                <td>{v.interface}</td>
                                <td className="px-6 py-4 text-right">
                                    <button onClick={() => handleDelete(v.id)} disabled={isSubmitting}><TrashIcon className="w-5 h-5"/></button>
                                </td>
                            </tr>
                        ))}
                        {vlans.length === 0 && (
                            <tr>
                                <td colSpan={4} className="text-center py-8 text-slate-500">No VLANs configured.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const IpRouteFormModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onSave: (routeData: IpRouteData, routeId?: string) => void;
    initialData: IpRoute | null;
    isLoading: boolean;
}> = ({ isOpen, onClose, onSave, initialData, isLoading }) => {
    // FIX: Initialize with default data to satisfy IpRouteData type.
    const [route, setRoute] = useState<IpRouteData>({ 'dst-address': '0.0.0.0/0', gateway: '', distance: '1', disabled: 'false' });

    useEffect(() => {
        if (isOpen) {
            setRoute(initialData ? { ...initialData } : { 'dst-address': '0.0.0.0/0', gateway: '', distance: '1', disabled: 'false' });
        }
    }, [initialData, isOpen]);

    if (!isOpen) return null;
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setRoute(r => ({ ...r, [name]: value }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(route, initialData?.id);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg">
                <form onSubmit={handleSubmit}>
                    <div className="p-6">
                        <h3 className="text-xl font-bold mb-4">{initialData ? 'Edit IP Route' : 'Add IP Route'}</h3>
                        <div className="space-y-4">
                            <div><label>Dst. Address</label><input name="dst-address" value={route['dst-address']} onChange={handleChange} required className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"/></div>
                            <div><label>Gateway</label><input name="gateway" value={route.gateway} onChange={handleChange} required className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"/></div>
                            <div><label>Distance</label><input type="number" name="distance" value={route.distance} onChange={handleChange} className="mt-1 w-full p-2 bg-slate-100 dark:bg-slate-700 rounded-md"/></div>
                        </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-900/50 px-6 py-3 flex justify-end gap-4">
                        <button type="button" onClick={onClose}>Cancel</button>
                        <button type="submit" disabled={isLoading} className="px-4 py-2 bg-[--color-primary-600] text-white rounded-md disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const IpRouteManager: React.FC<{ selectedRouter: RouterConfigWithId, interfaces: Interface[] }> = ({ selectedRouter, interfaces }) => {
    const [routes, setRoutes] = useState<IpRoute[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingRoute, setEditingRoute] = useState<IpRoute | null>(null);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await getIpRoutes(selectedRouter);
            setRoutes(data);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, [selectedRouter]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleSave = async (routeData: IpRouteData, routeId?: string) => {
        setIsSubmitting(true);
        try {
            if (routeId) {
                await updateIpRoute(selectedRouter, routeId, routeData);
            } else {
                await addIpRoute(selectedRouter, routeData);
            }
            setIsModalOpen(false);
            await fetchData();
        } catch (err) {
            alert(`Failed to save route: ${(err as Error).message}`);
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const handleDelete = async (routeId: string) => {
        if (!window.confirm("Are you sure?")) return;
        try {
            await deleteIpRoute(selectedRouter, routeId);
            await fetchData();
        } catch (err) {
            alert(`Failed to delete route: ${(err as Error).message}`);
        }
    };
    
    if (isLoading) return <div className="flex justify-center p-8"><Loader /></div>;
    if (error) return <div className="p-4 bg-red-100 text-red-700">{error}</div>;

    return (
        <div>
            <IpRouteFormModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSave={handleSave} initialData={editingRoute} isLoading={isSubmitting} />
            <div className="flex justify-end mb-4">
                <button onClick={() => { setEditingRoute(null); setIsModalOpen(true); }} className="bg-[--color-primary-600] text-white font-bold py-2 px-4 rounded-lg">Add Route</button>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-900/50">
                        <tr>
                            <th className="px-6 py-3">Destination</th>
                            <th className="px-6 py-3">Gateway</th>
                            <th className="px-6 py-3">Status</th>
                            <th className="px-6 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {routes.map(r => (
                            <tr key={r.id} className={`border-b dark:border-slate-700 ${r.disabled==='true' ? 'opacity-50':''}`}>
                                <td className="px-6 py-4 font-mono">{r['dst-address']}</td>
                                <td>{r.gateway}</td>
                                <td>{r.active === 'true' ? <span className="text-green-500">Active</span> : <span className="text-slate-500">Inactive</span>}</td>
                                <td className="px-6 py-4 text-right space-x-2">
                                    {r.static === 'true' && <button onClick={() => { setEditingRoute(r); setIsModalOpen(true); }}><EditIcon className="w-5 h-5"/></button>}
                                    {r.static === 'true' && <button onClick={() => handleDelete(r.id)}><TrashIcon className="w-5 h-5"/></button>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const WanFailoverManager: React.FC<{ selectedRouter: RouterConfigWithId }> = ({ selectedRouter }) => {
    const [status, setStatus] = useState<FailoverStatus | null>(null);
    const [routes, setRoutes] = useState<WanRoute[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    const fetchData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [statusData, routesData] = await Promise.all([
                getWanFailoverStatus(selectedRouter),
                getWanRoutes(selectedRouter)
            ]);
            setStatus(statusData);
            setRoutes(routesData.filter(r => r.checkGateway === 'ping'));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, [selectedRouter]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);
    
    const handleToggleFailover = async (enabled: boolean) => {
        setIsSubmitting(true);
        try {
            await configureWanFailover(selectedRouter, enabled);
            await fetchData();
        } catch (err) {
            alert(`Failed to toggle failover: ${(err as Error).message}`);
        } finally {
            setIsSubmitting(false);
        }
    };
    
    if (isLoading) return <div className="flex justify-center p-8"><Loader /></div>;
    if (error) return <div className="p-4 bg-red-100 text-red-700">{error}</div>;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center p-4 bg-white dark:bg-slate-800 rounded-lg shadow-md">
                <h3 className="text-xl font-bold">WAN Failover Status</h3>
                {status && (
                    <div className="flex items-center gap-4">
                        <span className={`font-semibold ${status.enabled ? 'text-green-500' : 'text-red-500'}`}>{status.enabled ? 'Enabled' : 'Disabled'}</span>
                        <ToggleSwitch checked={status.enabled} onChange={() => handleToggleFailover(!status.enabled)} disabled={isSubmitting} />
                    </div>
                )}
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-lg shadow-md overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-900/50">
                        <tr>
                            <th className="px-6 py-3">Gateway</th>
                            <th className="px-6 py-3">Distance</th>
                            <th className="px-6 py-3">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {routes.map(r => (
                            <tr key={r.id} className={`border-b dark:border-slate-700 ${r.disabled==='true' ? 'opacity-50':''}`}>
                                <td className="px-6 py-4 font-mono">{r.gateway}</td>
                                <td>{r.distance}</td>
                                <td>{r.active === 'true' ? <span className="text-green-500">Active</span> : <span className="text-red-500">Inactive</span>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

type NetworkTab = 'vlans' | 'dhcp' | 'routes' | 'failover' | 'firewall' | 'bridges';

const TabButton: React.FC<{ label: string, icon: React.ReactNode, isActive: boolean, onClick: () => void }> = ({ label, icon, isActive, onClick }) => (
    <button
        onClick={onClick}
        className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors duration-200 focus:outline-none ${
            isActive
                ? 'border-[--color-primary-500] text-[--color-primary-500] dark:text-[--color-primary-400]'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }`}
    >
        {icon}
        <span className="hidden sm:inline">{label}</span>
    </button>
);


export const Network: React.FC<{ selectedRouter: RouterConfigWithId | null }> = ({ selectedRouter }) => {
    const [activeTab, setActiveTab] = useState<NetworkTab>('routes');
    const [interfaces, setInterfaces] = useState<Interface[]>([]);
    const [isLoadingInterfaces, setIsLoadingInterfaces] = useState(true);

    const fetchInterfaces = useCallback(async () => {
        if (!selectedRouter) return;
        setIsLoadingInterfaces(true);
        try {
            const ifaces = await getInterfaces(selectedRouter);
            setInterfaces(ifaces);
        } catch (error) {
            console.error("Failed to fetch interfaces for Network component", error);
            setInterfaces([]);
        } finally {
            setIsLoadingInterfaces(false);
        }
    }, [selectedRouter]);

    useEffect(() => {
        fetchInterfaces();
    }, [fetchInterfaces]);

    if (!selectedRouter) {
        return (
            <div className="flex flex-col items-center justify-center h-96 text-center bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <RouterIcon className="w-16 h-16 text-slate-400 dark:text-slate-600 mb-4" />
                <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-200">Network Management</h2>
                <p className="mt-2 text-slate-500 dark:text-slate-400">Please select a router to manage its network settings.</p>
            </div>
        );
    }
    
    const renderContent = () => {
        switch(activeTab) {
            case 'vlans': return <VlanManager selectedRouter={selectedRouter} interfaces={interfaces} onDataChange={fetchInterfaces} />;
            case 'dhcp': return <DhcpManager selectedRouter={selectedRouter} />;
            case 'routes': return <IpRouteManager selectedRouter={selectedRouter} interfaces={interfaces} />;
            case 'failover': return <WanFailoverManager selectedRouter={selectedRouter} />;
            case 'firewall': return <Firewall selectedRouter={selectedRouter} interfaces={interfaces} />;
            case 'bridges': return <BridgeManager selectedRouter={selectedRouter} interfaces={interfaces} onDataChange={fetchInterfaces} />;
            default: return null;
        }
    };
    
    return (
        <div className="space-y-6">
            <div className="border-b border-slate-200 dark:border-slate-700">
                <nav className="flex space-x-2 -mb-px overflow-x-auto" aria-label="Tabs">
                    <TabButton label="IP Routes" icon={<ShareIcon className="w-5 h-5"/>} isActive={activeTab === 'routes'} onClick={() => setActiveTab('routes')} />
                    <TabButton label="WAN Failover" icon={<ShareIcon className="w-5 h-5"/>} isActive={activeTab === 'failover'} onClick={() => setActiveTab('failover')} />
                    <TabButton label="Firewall" icon={<ShieldCheckIcon className="w-5 h-5"/>} isActive={activeTab === 'firewall'} onClick={() => setActiveTab('firewall')} />
                    <TabButton label="Bridges" icon={<BridgeIcon className="w-5 h-5"/>} isActive={activeTab === 'bridges'} onClick={() => setActiveTab('bridges')} />
                    <TabButton label="VLANs" icon={<VlanIcon className="w-5 h-5"/>} isActive={activeTab === 'vlans'} onClick={() => setActiveTab('vlans')} />
                    <TabButton label="DHCP Server" icon={<ServerIcon className="w-5 h-5"/>} isActive={activeTab === 'dhcp'} onClick={() => setActiveTab('dhcp')} />
                </nav>
            </div>
            {isLoadingInterfaces ? <div className="flex justify-center p-8"><Loader /></div> : renderContent()}
        </div>
    );
};
