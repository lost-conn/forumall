use std::{future::Future, marker::PhantomData};

use dioxus::{
    hooks::{use_context, use_context_provider, use_resource, Resource},
    signals::{ReadableExt, Signal},
};

/// A hook that wraps `use_resource` and adds a signal to the context that can be used to refresh the resource.
///
/// You can access the signal using `use_refresh_resource::<T>()`.
///
/// ### Example
///
/// ```rust,ignore
/// // In a component. Can be used just like `use_resource`.
/// let result: Resource<T> = use_refreshable_resource(|| async {
///     // Do some async work
/// });
///
/// // Now in a child component, you can trigger a refresh of the resource.
/// // The `T` here is the same as the `T` in `result: Resource<T>` above.
/// let refresh: Signal<()> = use_refresh_resource::<T>();
///
/// rsx! {
///     // Pressing this button will cause the earlier async work to be re-run.
///     button { onclick: move |_| refresh.write(), "Refresh data" }
/// }
/// ```
pub fn use_refreshable_resource<T, F>(mut future: impl FnMut() -> F + 'static) -> Resource<T>
where
    T: 'static,
    F: Future<Output = T> + 'static,
{
    let context =
        use_context_provider::<(Signal<()>, PhantomData<T>)>(|| (Signal::new(()), PhantomData));
    use_resource(move || {
        context.0.read();
        future()
    })
}

/// See `use_refreshable_resource`.
pub fn use_refresh_resource<T>() -> Signal<()>
where
    T: 'static + Clone,
{
    let context = use_context::<(Signal<()>, PhantomData<T>)>();
    context.0
}
