document.addEventListener('DOMContentLoaded', () => {
    // Form elements
    const form = document.getElementById('builderForm');
    const steps = document.querySelectorAll('.step');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const submitBtn = document.getElementById('submitBtn');

    // Modal elements
    const previewModal = document.getElementById('previewModal');
    const closePreview = document.getElementById('closePreview');
    const previewContent = document.getElementById('previewContent');
    const errorModal = document.getElementById('errorModal');
    const closeError = document.getElementById('closeError');
    const errorMessage = document.getElementById('errorMessage');

    // State management
    let currentStep = 0;
    let selectedCategory = '';
    let selectedGeo = '';
    let selectedTemplate = '';
    let formDetails = {
        domainName: '',
        domainUrl: '',
        subpageName: ''
    };

    // Navigation functions
    function showStep(stepIndex) {
        steps.forEach((step, index) => {
            if (index === stepIndex) {
                step.classList.remove('hidden');
                step.classList.add('visible');
            } else {
                step.classList.add('hidden');
                step.classList.remove('visible');
            }
        });

        // Update navigation buttons
        prevBtn.style.display = stepIndex > 0 ? 'block' : 'none';
        nextBtn.style.display = stepIndex < steps.length - 1 ? 'block' : 'none';
        submitBtn.style.display = stepIndex === steps.length - 1 ? 'block' : 'none';

        // Load dynamic content if needed
        if (stepIndex === 1 && selectedCategory) loadGeos();
        if (stepIndex === 3 && selectedGeo) loadTemplates();
    }

    // Show error modal
    function showError(message) {
        errorMessage.textContent = message;
        errorModal.classList.remove('hidden');
    }

    // Event listeners for navigation
    prevBtn.addEventListener('click', () => {
        if (currentStep > 0) {
            currentStep--;
            showStep(currentStep);
        }
    });

    nextBtn.addEventListener('click', () => {
        if (validateStep(currentStep)) {
            if (currentStep < steps.length - 1) {
                currentStep++;
                showStep(currentStep);
            }
        } else {
            showValidationError(currentStep);
        }
    });

    // Step validation
    function validateStep(step) {
        switch (step) {
            case 0:
                return selectedCategory !== '';
            case 1:
                return selectedGeo !== '';
            case 2:
                // Validate form details
                const inputs = steps[2].querySelectorAll('input');
                let isValid = true;
                inputs.forEach(input => {
                    const value = input.value.trim();
                    if (value === '') {
                        isValid = false;
                        input.classList.add('border-red-500');
                    } else {
                        input.classList.remove('border-red-500');
                        formDetails[input.name] = value;
                    }
                });
                return isValid;
            case 3:
                return selectedTemplate !== '';
            default:
                return true;
        }
    }

    function showValidationError(step) {
        let message = '';
        switch (step) {
            case 0:
                message = 'Please select a category';
                break;
            case 1:
                message = 'Please select a GEO region';
                break;
            case 2:
                message = 'Please fill in all required fields';
                break;
            case 3:
                message = 'Please select a template';
                break;
        }
        showError(message);
    }

    // API calls
    async function loadGeos() {
        try {
            const response = await fetch(`/api/geos/${selectedCategory}`);
            if (!response.ok) throw new Error('Failed to fetch GEOs');
            
            const geos = await response.json();
            
            const geoContainer = document.getElementById('geoContainer');
            geoContainer.innerHTML = geos.map(geo => `
                <div class="geo-btn p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 focus:outline-none focus:border-blue-500 transition-colors cursor-pointer"
                     data-geo="${geo}">
                    <div class="flex flex-col items-center">
                        <i class="fas fa-globe text-2xl mb-2 text-blue-500"></i>
                        <p class="font-medium">${geo}</p>
                    </div>
                </div>
            `).join('');

            // Add click handlers for GEO buttons
            document.querySelectorAll('.geo-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.geo-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    selectedGeo = btn.dataset.geo;
                });
            });
        } catch (error) {
            console.error('Error loading GEOs:', error);
            showError('Failed to load GEO regions. Please try again.');
        }
    }

    async function loadTemplates() {
        try {
            const response = await fetch(`/api/templates/${selectedCategory}/${selectedGeo}`);
            if (!response.ok) throw new Error('Failed to fetch templates');
            
            const templates = await response.json();
            
            const templateContainer = document.getElementById('templateContainer');
            templateContainer.innerHTML = templates.map(template => `
                <div class="template-card p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 focus:outline-none focus:border-blue-500 transition-colors cursor-pointer"
                     data-template="${template.name}">
                    <div class="aspect-w-16 aspect-h-9 mb-4">
                        <img src="${template.thumbnail}" alt="${template.name}" class="object-cover rounded">
                    </div>
                    <h4 class="font-medium text-gray-800">${template.name}</h4>
                    <p class="text-sm text-gray-600">${template.description}</p>
                </div>
            `).join('');

            // Add click handlers for template cards
            document.querySelectorAll('.template-card').forEach(card => {
                card.addEventListener('click', () => {
                    // Remove selected class from all templates
                    document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected', 'border-blue-500', 'bg-blue-50'));
                    // Add selected class to clicked template
                    card.classList.add('selected', 'border-blue-500', 'bg-blue-50');
                    selectedTemplate = card.querySelector('h4').textContent;
                });
            });
        } catch (error) {
            console.error('Error loading templates:', error);
            showError('Failed to load templates. Please try again.');
        }
    }

    // Form submission
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!validateStep(3)) {
            showValidationError(3);
            return;
        }

        const data = {
            category: selectedCategory,
            geo: selectedGeo,
            template: selectedTemplate,
            ...formDetails
        };

        try {
            // Show loading state
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<div class="spinner inline-block"></div> Generating...';

            // Generate subpage
            const response = await fetch('/api/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) throw new Error('Failed to generate subpage');

            const result = await response.json();
            
            if (result.previewUrl) {
                // Show preview
                previewContent.innerHTML = `<iframe src="${result.previewUrl}" class="w-full h-[500px]"></iframe>`;
                previewModal.classList.remove('hidden');
            }
            
            // Trigger download
            window.location.href = result.downloadUrl;
        } catch (error) {
            console.error('Error generating subpage:', error);
            showError('Failed to generate subpage. Please try again.');
        } finally {
            // Reset loading state
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Generate Subpage';
        }
    });

    // Category selection
    document.querySelectorAll('.category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedCategory = btn.dataset.category;
        });
    });

    // Input field validation
    const detailsInputs = steps[2].querySelectorAll('input');
    detailsInputs.forEach(input => {
        input.addEventListener('input', () => {
            if (input.value.trim() !== '') {
                input.classList.remove('border-red-500');
            }
        });
    });

    // Modal handling
    closePreview.addEventListener('click', () => {
        previewModal.classList.add('hidden');
        // Reset form and go back to first step
        form.reset();
        selectedCategory = '';
        selectedGeo = '';
        selectedTemplate = '';
        currentStep = 0;
        showStep(currentStep);
        
        // Remove selected states from all buttons and cards
        document.querySelectorAll('.category-btn, .geo-btn, .template-card').forEach(el => {
            el.classList.remove('selected', 'border-blue-500', 'bg-blue-50');
        });
        
        // Clear form inputs
        detailsInputs.forEach(input => {
            input.classList.remove('border-red-500');
            input.value = '';
        });
    });

    closeError.addEventListener('click', () => {
        errorModal.classList.add('hidden');
    });

    // Close modals when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            previewModal.classList.add('hidden');
            // Reset form and go back to first step
            form.reset();
            selectedCategory = '';
            selectedGeo = '';
            selectedTemplate = '';
            currentStep = 0;
            showStep(currentStep);
            
            // Remove selected states from all buttons and cards
            document.querySelectorAll('.category-btn, .geo-btn, .template-card').forEach(el => {
                el.classList.remove('selected', 'border-blue-500', 'bg-blue-50');
            });
            
            // Clear form inputs
            detailsInputs.forEach(input => {
                input.classList.remove('border-red-500');
                input.value = '';
            });
        }
        if (e.target === errorModal) {
            errorModal.classList.add('hidden');
        }
    });

    // Initialize first step
    showStep(0);

    // Add Template Modal Functionality
    const addTemplateBtn = document.getElementById('addTemplateBtn');
    const addTemplateModal = document.getElementById('addTemplateModal');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const addTemplateForm = document.getElementById('addTemplateForm');
    const categorySelect = document.getElementById('categorySelect');
    const geoSelect = document.getElementById('geoSelect');
    const newCategory = document.getElementById('newCategory');
    const newGeo = document.getElementById('newGeo');

    // Fetch existing categories and GEOs
    async function fetchExistingData() {
        try {
            // Get categories from the templates directory
            const categoriesResponse = await fetch('/api/categories');
            const categories = await categoriesResponse.json();
            
            // Get all GEOs from all categories
            const geosResponse = await fetch('/api/geos');
            const geos = await geosResponse.json();
            
            // Clear existing options except the default and "Add New" options
            while (categorySelect.options.length > 2) {
                categorySelect.remove(1);
            }
            while (geoSelect.options.length > 2) {
                geoSelect.remove(1);
            }
            
            // Add categories to select
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                // Insert before the "Add New" option
                categorySelect.insertBefore(option, categorySelect.lastElementChild);
            });
            
            // Add GEOs to select
            geos.forEach(geo => {
                const option = document.createElement('option');
                option.value = geo;
                option.textContent = geo;
                // Insert before the "Add New" option
                geoSelect.insertBefore(option, geoSelect.lastElementChild);
            });
        } catch (error) {
            console.error('Error fetching data:', error);
            alert('Error loading categories and GEOs');
        }
    }

    // Show/hide modal
    function toggleModal(show = true) {
        if (show) {
            addTemplateModal.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        } else {
            addTemplateModal.classList.add('hidden');
            document.body.style.overflow = '';
            addTemplateForm.reset();
            newCategory.classList.add('hidden');
            newGeo.classList.add('hidden');
        }
    }

    // Event listeners
    addTemplateBtn.addEventListener('click', () => toggleModal(true));
    closeModalBtn.addEventListener('click', () => toggleModal(false));
    cancelBtn.addEventListener('click', () => toggleModal(false));

    // Close modal when clicking outside
    addTemplateModal.addEventListener('click', (e) => {
        if (e.target === addTemplateModal) {
            toggleModal(false);
        }
    });

    // Handle category selection
    categorySelect.addEventListener('change', (e) => {
        if (e.target.value === 'new') {
            newCategory.classList.remove('hidden');
        } else {
            newCategory.classList.add('hidden');
        }
    });

    // Handle geo selection
    geoSelect.addEventListener('change', (e) => {
        if (e.target.value === 'new') {
            newGeo.classList.remove('hidden');
        } else {
            newGeo.classList.add('hidden');
        }
    });

    // Handle form submission
    addTemplateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        const category = categorySelect.value === 'new' ? newCategory.value : categorySelect.value;
        const geo = geoSelect.value === 'new' ? newGeo.value : geoSelect.value;
        const templateName = document.getElementById('templateName').value;
        const templateFile = document.getElementById('templateFile').files[0];

        // Validate form data
        if (!category || (categorySelect.value === 'new' && !newCategory.value)) {
            alert('Please select or enter a category');
            return;
        }

        if (!geo || (geoSelect.value === 'new' && !newGeo.value)) {
            alert('Please select or enter a GEO region');
            return;
        }

        if (!templateName) {
            alert('Please enter a template name');
            return;
        }

        if (!templateFile) {
            alert('Please select a ZIP file');
            return;
        }

        if (!templateFile.name.toLowerCase().endsWith('.zip')) {
            alert('Please select a ZIP file');
            return;
        }
        
        formData.append('category', category);
        formData.append('geo', geo);
        formData.append('name', templateName);
        formData.append('template', templateFile);

        try {
            const submitButton = addTemplateForm.querySelector('button[type="submit"]');
            const originalText = submitButton.innerHTML;
            submitButton.disabled = true;
            submitButton.innerHTML = '<div class="spinner inline-block"></div> Uploading...';
            
            const response = await fetch('/api/templates', {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (response.ok) {
                alert('Template added successfully!');
                toggleModal(false);
                // Refresh the templates list if we're on the template selection step
                if (currentStep === 3) {
                    await loadTemplates(currentCategory, currentGeo);
                }
                // Refresh the dropdowns
                await fetchExistingData();
            } else {
                throw new Error(result.details || result.message || 'Failed to add template');
            }
        } catch (error) {
            console.error('Error:', error);
            alert(error.message || 'Error adding template');
        } finally {
            const submitButton = addTemplateForm.querySelector('button[type="submit"]');
            submitButton.disabled = false;
            submitButton.innerHTML = 'Add Template';
        }
    });

    // Initialize
    fetchExistingData();
}); 