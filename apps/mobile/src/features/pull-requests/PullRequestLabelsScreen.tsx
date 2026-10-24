import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestLabelCandidate } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ScrollViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollViewMarker } from "react-native-screens";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { pullRequestLabelColor } from "./pullRequestList";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

function LabelScrollView(props: ScrollViewProps) {
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} contentInsetAdjustmentBehavior="automatic" />
    </ScrollViewMarker>
  );
}

export function PullRequestLabelsScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<PullRequestLabelCandidate>>(null);
  const nativeMetrics = useNativeLayoutMetrics();
  const integratedSearch =
    NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED &&
    (!nativeMetrics || nativeMetrics.verticalBarEdge === "none");
  const target = pullRequestTarget(route.params);
  const pr = useEnvironmentQuery(composerPullRequests.detail(target)).data;
  const canWrite = useAtomValue(
    composerPullRequests.setLabels.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(route.params.environmentId);
  const allowed =
    connected &&
    canWrite &&
    pr?.capabilities.labels === true &&
    pr.viewerPermissions.labels !== false;
  const result = useEnvironmentQuery(composerPullRequests.labelCandidates(target));
  const setLabels = useAtomCommand(composerPullRequests.setLabels, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const needle = query.trim().toLowerCase();
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.candidates ?? []).filter((candidate) =>
    `${candidate.name} ${candidate.description ?? ""}`.toLowerCase().includes(needle),
  );
  const search = (text: string) => {
    setQuery(text);
    listRef.current?.scrollToOffset({
      offset: Platform.OS === "ios" ? -insets.top : 0,
      animated: false,
    });
  };
  const toggle = async (candidate: PullRequestLabelCandidate) => {
    if (!allowed || inFlight.current) return;
    inFlight.current = true;
    setPending(candidate.name);
    setError(null);
    const response = await setLabels({
      ...target,
      input: { ...target.input, labels: [candidate.name], applied: !candidate.isApplied },
    });
    inFlight.current = false;
    setPending(null);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      setError(cause instanceof Error ? cause.message : "Couldn't update this label. Try again.");
    }
  };
  const searchOptions = {
    placeholder: "Search labels",
    autoCapitalize: "none" as const,
    onChangeText: (event: { nativeEvent: { text: string } }) => search(event.nativeEvent.text),
    onCancelButtonPress: () => search(""),
    hideNavigationBar: false,
    hideWhenScrolling: false,
    obscureBackground: false,
    allowToolbarIntegration: integratedSearch,
    placement: integratedSearch ? ("automatic" as const) : ("stacked" as const),
  };
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title="Labels"
        subtitle={`#${route.params.number} · ${route.params.repository}`}
        onClose={() => navigation.goBack()}
        accessibilityLabel="Close labels"
      />
      <NativeStackScreenOptions
        options={{
          headerSearchBarOptions: searchOptions,
          unstable_headerToolbarItems: () =>
            integratedSearch
              ? [
                  createNativeMailSearchToolbarItem({
                    placeholder: "Search labels",
                    onSearchTextChange: search,
                    showsSearchDismissButton: true,
                    searchTextChangeId: "pr-label-search",
                  }),
                ]
              : [],
        }}
      />
      <FlatList
        ref={listRef}
        data={candidates}
        keyExtractor={(candidate) => candidate.name}
        renderScrollComponent={
          Platform.OS === "ios" ? (props) => <LabelScrollView {...props} /> : undefined
        }
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-3 px-4 py-4">
            {Platform.OS === "android" ? (
              <TextInput
                accessibilityLabel="Search labels"
                placeholder="Search labels"
                placeholderTextColorClassName="accent-foreground-muted"
                value={query}
                onChangeText={search}
                autoCapitalize="none"
                className="min-h-11 rounded-xl bg-grouped-card px-3 text-sm"
              />
            ) : null}
            {!allowed && pr ? (
              <Text className="text-xs text-foreground-muted">
                Changing labels needs triage access on this repository.
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const color = pullRequestLabelColor(item.color);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.isApplied ? "Remove label" : "Add label"} ${item.name}`}
              accessibilityState={{
                disabled: !allowed || pending !== null,
                selected: item.isApplied,
              }}
              disabled={!allowed || pending !== null}
              onPress={() => void toggle(item)}
              className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
            >
              <View
                className="size-3 rounded-full bg-foreground-muted"
                style={color ? { backgroundColor: color } : undefined}
              />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-t3-medium" numberOfLines={1}>
                  {item.name}
                </Text>
                {item.description ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}
              </View>
              {pending === item.name ? (
                <AppActivityIndicator />
              ) : item.isApplied ? (
                <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          result.isPending && !result.data ? (
            <AppActivityIndicator className="my-8" />
          ) : (
            <View className="px-4 py-6">
              <EmptyState
                title={
                  result.error
                    ? "Couldn't load labels"
                    : needle
                      ? "No matching labels"
                      : "This repository has no labels"
                }
                detail={
                  result.error ??
                  (needle ? "Try another name." : "Create labels on the provider to use them here.")
                }
                variant="plain"
              />
              {result.error ? <Button label="Retry" onPress={result.refresh} /> : null}
            </View>
          )
        }
        ListFooterComponent={
          result.data?.truncated ? (
            <Text className="px-4 py-4 text-xs text-foreground-muted">
              This repository has more labels than are listed here. Apply the rest on the provider.
            </Text>
          ) : undefined
        }
      />
    </View>
  );
}
