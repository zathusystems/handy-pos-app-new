'use client';

import React, { useState, useEffect } from 'react';
import { Plus, AlertCircle, CheckCircle2, Clock, Loader2, Edit, Trash2, Eye } from 'lucide-react';
import { authFetch } from '@/lib/auth-fetch';
import { toast } from '@/hooks/use-toast';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface StockAuditRecord {
  id: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  totalDiscrepancyValue: number;
  approvalRole?: string;
  mraVisible: boolean;
  inventoryLocked: boolean;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  itemCount: number;
}

interface StockAuditTabProps {
  branchId?: string;
  inventoryData?: any[];
}

export function StockAuditTab({ branchId, inventoryData = [] }: StockAuditTabProps) {
  const [audits, setAudits] = useState<StockAuditRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [selectedAudit, setSelectedAudit] = useState<StockAuditRecord | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [auditNotes, setAuditNotes] = useState('');

  // Load audits
  useEffect(() => {
    const loadAudits = async () => {
      if (!branchId) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        const response = await authFetch.fetch<any>(
          `/inventory/stock-audits/?branch_id=${branchId}`
        );

        if (response && Array.isArray(response)) {
          const auditRecords = response.map((audit: any) => ({
            id: audit.id,
            status: audit.status,
            totalDiscrepancyValue: parseFloat(audit.total_discrepancy_value),
            approvalRole: audit.approval_role,
            mraVisible: audit.mra_visible,
            inventoryLocked: audit.inventory_locked,
            createdBy: audit.created_by,
            createdAt: audit.created_at,
            approvedBy: audit.approved_by,
            approvedAt: audit.approved_at,
            itemCount: audit.items?.length || 0,
          }));
          setAudits(auditRecords);
        } else if (response?.results && Array.isArray(response.results)) {
          const auditRecords = response.results.map((audit: any) => ({
            id: audit.id,
            status: audit.status,
            totalDiscrepancyValue: parseFloat(audit.total_discrepancy_value),
            approvalRole: audit.approval_role,
            mraVisible: audit.mra_visible,
            inventoryLocked: audit.inventory_locked,
            createdBy: audit.created_by,
            createdAt: audit.created_at,
            approvedBy: audit.approved_by,
            approvedAt: audit.approved_at,
            itemCount: audit.items?.length || 0,
          }));
          setAudits(auditRecords);
        }
      } catch (error) {
        console.error('Failed to load audits:', error);
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to load stock audits',
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadAudits();
  }, [branchId]);

  const handleCreateAudit = async () => {
    if (!branchId) return;

    try {
      setIsSubmitting(true);
      const response = await authFetch.fetch<any>(
        '/inventory/stock-audits/',
        {
          method: 'POST',
          body: JSON.stringify({
            branch_id: branchId,
            notes: auditNotes,
          }),
        }
      );

      if (response?.id) {
        const newAudit: StockAuditRecord = {
          id: response.id,
          status: response.status,
          totalDiscrepancyValue: 0,
          mraVisible: response.mra_visible,
          inventoryLocked: response.inventory_locked,
          createdBy: response.created_by,
          createdAt: response.created_at,
          itemCount: 0,
        };

        setAudits([newAudit, ...audits]);
        setIsCreateDialogOpen(false);
        setAuditNotes('');

        toast({
          title: 'Success',
          description: 'Stock audit created successfully',
        });
      }
    } catch (error) {
      console.error('Failed to create audit:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create stock audit',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApproveAudit = async (auditId: string, role: string) => {
    try {
      setIsSubmitting(true);
      await authFetch.fetch<any>(
        `/inventory/stock-audits/${auditId}/approve/`,
        {
          method: 'POST',
          body: JSON.stringify({ approval_role: role }),
        }
      );

      // Update local state
      setAudits(audits =>
        audits.map(audit =>
          audit.id === auditId
            ? {
                ...audit,
                status: 'Approved',
                inventoryLocked: true,
                approvedAt: new Date().toISOString(),
              }
            : audit
        )
      );

      toast({
        title: 'Success',
        description: 'Stock audit approved',
      });
    } catch (error) {
      console.error('Failed to approve audit:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to approve stock audit',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRejectAudit = async (auditId: string) => {
    try {
      setIsSubmitting(true);
      await authFetch.fetch<any>(
        `/inventory/stock-audits/${auditId}/reject/`,
        { method: 'POST' }
      );

      // Update local state
      setAudits(audits =>
        audits.map(audit =>
          audit.id === auditId
            ? { ...audit, status: 'Rejected' }
            : audit
        )
      );

      toast({
        title: 'Success',
        description: 'Stock audit rejected',
      });
    } catch (error) {
      console.error('Failed to reject audit:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to reject stock audit',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Approved':
        return 'bg-green-100 text-green-800';
      case 'Rejected':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Pending':
        return <Clock className="h-4 w-4" />;
      case 'Approved':
        return <CheckCircle2 className="h-4 w-4" />;
      case 'Rejected':
        return <AlertCircle className="h-4 w-4" />;
      default:
        return null;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Audits</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{audits.length}</div>
            <p className="text-xs text-muted-foreground mt-1">All time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {audits.filter(a => a.status === 'Pending').length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting approval</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Approved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {audits.filter(a => a.status === 'Approved').length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Completed</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Locked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {audits.filter(a => a.inventoryLocked).length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Inventory locked</p>
          </CardContent>
        </Card>
      </div>

      {/* Create Audit Button */}
      <div className="flex justify-end">
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create Stock Audit
        </Button>
      </div>

      {/* Audits Table */}
      <Card>
        <CardHeader>
          <CardTitle>Stock Audits</CardTitle>
          <CardDescription>
            View and manage all stock audits
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audits.length === 0 ? (
            <div className="text-center py-8">
              <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No stock audits found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Discrepancy Value</TableHead>
                    <TableHead>Created By</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Approved By</TableHead>
                    <TableHead>MRA Visible</TableHead>
                    <TableHead>Locked</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audits.map((audit) => (
                    <TableRow key={audit.id}>
                      <TableCell>
                        <Badge className={getStatusColor(audit.status)}>
                          {getStatusIcon(audit.status)}
                          <span className="ml-1">{audit.status}</span>
                        </Badge>
                      </TableCell>
                      <TableCell>{audit.itemCount}</TableCell>
                      <TableCell className="font-mono">
                        {audit.totalDiscrepancyValue.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-sm">{audit.createdBy}</TableCell>
                      <TableCell className="text-sm">
                        {new Date(audit.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {audit.approvedBy || '-'}
                      </TableCell>
                      <TableCell>
                        {audit.mraVisible ? (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700">
                            Visible
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-gray-50 text-gray-700">
                            Hidden
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {audit.inventoryLocked ? (
                          <Badge variant="outline" className="bg-red-50 text-red-700">
                            Locked
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-green-50 text-green-700">
                            Unlocked
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedAudit(audit);
                              setIsDetailDialogOpen(true);
                            }}
                          >
                            <Eye className="h-3 w-3" />
                          </Button>
                          {audit.status === 'Pending' && (
                            <>
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => handleApproveAudit(audit.id, 'Manager')}
                                disabled={isSubmitting}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => handleRejectAudit(audit.id)}
                                disabled={isSubmitting}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Audit Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Stock Audit</DialogTitle>
            <DialogDescription>
              Start a new stock audit for this branch
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Notes (Optional)</label>
              <Input
                placeholder="Add notes about this audit..."
                value={auditNotes}
                onChange={(e) => setAuditNotes(e.target.value)}
                className="mt-2"
              />
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-900">
                ℹ️ This will create a new stock audit. You'll be able to record discrepancies and submit for approval.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateAudit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Audit'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Audit Details</DialogTitle>
            <DialogDescription>
              View detailed information about this stock audit
            </DialogDescription>
          </DialogHeader>

          {selectedAudit && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Status</label>
                <div className="mt-1">
                  <Badge className={getStatusColor(selectedAudit.status)}>
                    {getStatusIcon(selectedAudit.status)}
                    <span className="ml-1">{selectedAudit.status}</span>
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Items Audited</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedAudit.itemCount}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Discrepancy Value</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedAudit.totalDiscrepancyValue.toFixed(2)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Created By</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedAudit.createdBy}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Created At</label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {new Date(selectedAudit.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>

              {selectedAudit.approvedBy && (
                <div className="grid grid-cols-2 gap-4 border-t pt-4">
                  <div>
                    <label className="text-sm font-medium">Approved By</label>
                    <p className="text-sm text-muted-foreground mt-1">
                      {selectedAudit.approvedBy}
                    </p>
                  </div>

                  <div>
                    <label className="text-sm font-medium">Approved At</label>
                    <p className="text-sm text-muted-foreground mt-1">
                      {selectedAudit.approvedAt
                        ? new Date(selectedAudit.approvedAt).toLocaleString()
                        : '-'}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">MRA Visible</label>
                  <Badge variant="outline">
                    {selectedAudit.mraVisible ? 'Yes' : 'No'}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Inventory Locked</label>
                  <Badge variant="outline">
                    {selectedAudit.inventoryLocked ? 'Yes' : 'No'}
                  </Badge>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
