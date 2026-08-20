"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Save, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { QuickCommand } from "@/app/actions/settings";
import { getCategories, createCategory } from "@/app/actions/categories";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { centsToDecimal, formatMoney, tryParseAmount } from "@/lib/money";

type QuickCommandsManagerProps = {
  quickCommands: QuickCommand[];
  onSave: (commands: QuickCommand[]) => void;
};

type Category = {
  id: number;
  name: string;
  type: string;
};

export function QuickCommandsManager({ quickCommands, onSave }: QuickCommandsManagerProps) {
  const [commands, setCommands] = useState<QuickCommand[]>(quickCommands);
  const [hasChanges, setHasChanges] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [newCategories, setNewCategories] = useState<string[]>([]);
  const [focusedCommandId, setFocusedCommandId] = useState<number | null>(null);
  const [editingCommandId, setEditingCommandId] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    setCommands(quickCommands);
  }, [quickCommands]);

  const loadCategories = async () => {
    const cats = await getCategories();
    setCategories(cats);
  };

  const addCommand = () => {
    const newCommand: QuickCommand = {
      id: Date.now(),
      command: "",
      categoryName: "",
      amountCents: 0,
      comment: "",
    };
    setCommands([...commands, newCommand]);
    setEditingCommandId(newCommand.id);
    setHasChanges(true);
  };

  const updateCommand = (id: number, field: keyof QuickCommand, value: string | number) => {
    setCommands(
      commands.map((cmd) =>
        cmd.id === id ? { ...cmd, [field]: value } : cmd
      )
    );
    setHasChanges(true);
  };

  const deleteCommand = (id: number) => {
    setCommands(commands.filter((cmd) => cmd.id !== id));
    setHasChanges(true);
  };

  const getCategorySuggestions = (input: string) => {
    if (!input) return categories;

    const filtered = categories.filter(c =>
      c.name.toLowerCase().includes(input.toLowerCase())
    );

    return filtered;
  };

  const handleSave = async () => {

    const missingCategories = commands
      .filter(cmd => cmd.categoryName)
      .filter(cmd => !categories.some(c =>
        c.name.toLowerCase() === cmd.categoryName.toLowerCase()
      ))
      .map(cmd => cmd.categoryName)
      .filter((value, index, self) => self.indexOf(value) === index);

    if (missingCategories.length > 0) {
      setNewCategories(missingCategories);
      setShowConfirmDialog(true);
    } else {
      onSave(commands);
      setHasChanges(false);
    }
  };

  const handleConfirmSave = async () => {
    setError(null);

    for (const categoryName of newCategories) {
      const formData = new FormData();
      formData.append("name", categoryName);
      formData.append("type", "Expense");
      formData.append("icon", "DollarSign");
      formData.append("color", "#10b981");

      const result = await createCategory(formData);

      if (result && "error" in result && result.error) {
        setError(`Could not create category "${categoryName}": ${result.error}`);
        return;
      }
    }

    await loadCategories();

    onSave(commands);
    setHasChanges(false);
    setShowConfirmDialog(false);
    setNewCategories([]);
    setEditingCommandId(null);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Quick Commands</CardTitle>
              <CardDescription>
                Create shortcuts for frequently used transactions
              </CardDescription>
            </div>
            <Button onClick={addCommand} size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Command
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {commands.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No quick commands yet. Add one to get started!
            </div>
          ) : (
            <>
              {commands.map((cmd) => {
                const categoryExists = categories.some(
                  c => c.name.toLowerCase() === cmd.categoryName.toLowerCase()
                );
                const suggestions = getCategorySuggestions(cmd.categoryName);
                const showSuggestions = focusedCommandId === cmd.id && cmd.categoryName.length > 0;
                const isEditing = editingCommandId === cmd.id || !cmd.command || !cmd.categoryName;

                if (!isEditing) {
                  return (
                    <div
                      key={cmd.id}
                      className="rounded-lg border p-3 flex items-center justify-between hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <code className="text-sm font-mono bg-muted px-2 py-1 rounded font-medium">
                          /{cmd.command}
                        </code>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">→</span>
                          <span className="font-medium">{cmd.categoryName}</span>
                          <span className="text-muted-foreground">•</span>
                          <span className="font-semibold" data-private-value>{formatMoney(cmd.amountCents)}</span>
                          {cmd.comment && (
                            <>
                              <span className="text-muted-foreground">•</span>
                              <span className="text-muted-foreground text-xs" data-privacy-exempt>
                                {cmd.comment}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingCommandId(cmd.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteCommand(cmd.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={cmd.id}
                    className="rounded-lg border p-4 space-y-3"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`command-${cmd.id}`}>Command</Label>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">/</span>
                          <Input
                            id={`command-${cmd.id}`}
                            value={cmd.command}
                            onChange={(e) =>
                              updateCommand(cmd.id, "command", e.target.value)
                            }
                            placeholder="salary"
                          />
                        </div>
                      </div>

                      <div className="space-y-2 relative">
                        <Label htmlFor={`category-${cmd.id}`}>Category Name</Label>
                        <Input
                          id={`category-${cmd.id}`}
                          value={cmd.categoryName}
                          onChange={(e) =>
                            updateCommand(cmd.id, "categoryName", e.target.value)
                          }
                          onFocus={() => setFocusedCommandId(cmd.id)}
                          onBlur={() => setTimeout(() => setFocusedCommandId(null), 200)}
                          placeholder="Salary"
                          autoComplete="off"
                        />

                        {showSuggestions && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg z-50 max-h-48 overflow-y-auto">
                            {suggestions.length > 0 ? (
                              suggestions.map((cat) => (
                                <button
                                  key={cat.id}
                                  type="button"
                                  className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between text-sm"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    updateCommand(cmd.id, "categoryName", cat.name);
                                    setFocusedCommandId(null);
                                  }}
                                >
                                  <span>{cat.name}</span>
                                  <span className="text-xs text-muted-foreground">{cat.type}</span>
                                </button>
                              ))
                            ) : null}

                            {!categoryExists && cmd.categoryName && (
                              <button
                                type="button"
                                className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 text-sm border-t"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setFocusedCommandId(null);
                                }}
                              >
                                <Plus className="h-3 w-3" />
                                <span>Create category &quot;{cmd.categoryName}&quot;</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`amount-${cmd.id}`}>Amount</Label>
                        <Input
                          id={`amount-${cmd.id}`}
                          type="number"
                          data-private-input
                          step="0.01"
                          value={centsToDecimal(cmd.amountCents)}
                          onChange={(e) =>

                            updateCommand(cmd.id, "amountCents", tryParseAmount(e.target.value) ?? 0)
                          }
                          placeholder="0.00"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`comment-${cmd.id}`}>Description</Label>
                        <Input
                          id={`comment-${cmd.id}`}
                          value={cmd.comment}
                          onChange={(e) =>
                            updateCommand(cmd.id, "comment", e.target.value)
                          }
                          placeholder="Monthly salary"
                        />
                      </div>
                    </div>

                    <div className="flex justify-between items-center pt-2">
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-muted px-2 py-1 rounded">
                          /{cmd.command} → {cmd.categoryName}{" "}
                          <span data-private-value>{formatMoney(cmd.amountCents)}</span>
                        </code>
                        {!categoryExists && cmd.categoryName && (
                          <div className="flex items-center gap-1 text-xs text-orange-600">
                            <AlertCircle className="h-3 w-3" />
                            <span>Will be created</span>
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteCommand(cmd.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}

              {hasChanges && (
                <Button onClick={handleSave} className="w-full">
                  <Save className="mr-2 h-4 w-4" />
                  Save Quick Commands
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create New Categories?</AlertDialogTitle>
            <AlertDialogDescription>
              The following categories don&apos;t exist yet and will be created automatically:
              <ul className="mt-2 space-y-1">
                {newCategories.map((cat) => (
                  <li key={cat} className="font-medium text-foreground">
                    • {cat}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">
                They will be created as Expense categories with default settings. You can edit them later in the Budgets page.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave}>
              Create & Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
